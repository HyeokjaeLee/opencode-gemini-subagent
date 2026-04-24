import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import path from "node:path";
import { AGENTS_DIR } from "./paths.js";
import { runPrompt, runPromptBackground } from "./bridge.js";

const VALID_APPROVAL = new Set(["default", "auto_edit", "yolo", "plan"]);
const VALID_FORMAT = new Set(["text", "json", "stream-json"]);
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export interface PresetArgSpec {
  name: string;
  description: string;
  required: boolean;
}

export interface GeminiPreset {
  name: string;
  toolName: string;
  filePath: string;
  description: string;
  promptTemplate: string;
  args: PresetArgSpec[];
  model: string | undefined;
  approvalMode: "default" | "auto_edit" | "yolo" | "plan";
  outputFormat: "text" | "json" | "stream-json";
  timeoutMs: number;
}

function splitFrontmatter(raw: string): { yaml: string; body: string } {
  if (!raw.startsWith("---")) {
    throw new Error("missing YAML frontmatter (file must start with `---`)");
  }
  const end = raw.indexOf("\n---", 3);
  if (end === -1) {
    throw new Error("unterminated YAML frontmatter (missing closing `---`)");
  }
  const yaml = raw.slice(3, end).trim();
  let body = raw.slice(end + 4);
  if (body.startsWith("\n")) body = body.slice(1);
  return { yaml, body };
}

interface RawArgEntry {
  name?: string;
  description?: string;
  required?: boolean;
}

function validateArgs(rawArgs: unknown): PresetArgSpec[] {
  if (rawArgs === undefined) return [];
  if (!Array.isArray(rawArgs)) {
    throw new Error("`args` must be a list");
  }
  const seen = new Set<string>();
  const out: PresetArgSpec[] = [];
  for (const entry of rawArgs) {
    if (!entry || typeof entry !== "object") {
      throw new Error("each `args` entry must be an object");
    }
    const e = entry as RawArgEntry;
    const { name, description, required } = e;
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      throw new Error(
        `arg name must match ${NAME_RE} (got ${JSON.stringify(name)})`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`duplicate arg name: ${name}`);
    }
    seen.add(name);
    out.push({
      name,
      description: typeof description === "string" ? description : "",
      required: required === true,
    });
  }
  return out;
}

export async function parsePresetFile(filePath: string): Promise<GeminiPreset> {
  const raw = await Bun.file(filePath).text();
  const { yaml, body } = splitFrontmatter(raw);

  let fm: Record<string, unknown>;
  try {
    fm = parseYaml(yaml) as Record<string, unknown> ?? {};
  } catch (err) {
    throw new Error(`YAML parse error: ${(err as Error).message}`);
  }
  if (typeof fm !== "object" || Array.isArray(fm)) {
    throw new Error("frontmatter must be a YAML mapping");
  }

  const basename = path.basename(filePath, ".md");
  if (!NAME_RE.test(basename)) {
    throw new Error(
      `preset filename must match ${NAME_RE} (got ${basename}.md)`,
    );
  }

  const description =
    typeof fm.description === "string" ? fm.description.trim() : "";
  if (!description) {
    throw new Error("`description` is required in frontmatter");
  }

  const approvalMode = (fm.approval_mode ?? "plan") as string;
  if (!VALID_APPROVAL.has(approvalMode)) {
    throw new Error(
      `invalid approval_mode (got ${JSON.stringify(approvalMode)})`,
    );
  }

  const outputFormat = (fm.output_format ?? "text") as string;
  if (!VALID_FORMAT.has(outputFormat)) {
    throw new Error(
      `invalid output_format (got ${JSON.stringify(outputFormat)})`,
    );
  }

  const timeoutMs =
    typeof fm.timeout_ms === "number" && Number.isFinite(fm.timeout_ms)
      ? fm.timeout_ms as number
      : 180_000;

  const model = typeof fm.model === "string" ? fm.model as string : undefined;

  return {
    name: basename,
    toolName: `gemini_${basename}`,
    filePath,
    description,
    promptTemplate: body,
    args: validateArgs(fm.args),
    model,
    approvalMode: approvalMode as GeminiPreset["approvalMode"],
    outputFormat: outputFormat as GeminiPreset["outputFormat"],
    timeoutMs,
  };
}

export async function loadPresets(): Promise<{ presets: GeminiPreset[]; errors: Array<{ file: string; message: string }> }> {
  if (!existsSync(AGENTS_DIR)) {
    return { presets: [], errors: [] };
  }

  const presets: GeminiPreset[] = [];
  const errors: Array<{ file: string; message: string }> = [];

  const glob = new Bun.Glob("*.md");
  for await (const match of glob.scan({ cwd: AGENTS_DIR })) {
    const filePath = path.join(AGENTS_DIR, match);
    try {
      presets.push(await parsePresetFile(filePath));
    } catch (err) {
      errors.push({ file: filePath, message: (err as Error)?.message ?? String(err) });
    }
  }

  presets.sort((a, b) => a.name.localeCompare(b.name));
  return { presets, errors };
}

export function renderPromptTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, k: string) => {
    const v = values[k];
    if (v === undefined || v === null) return "";
    return String(v);
  });
}

function renderPresetPrompt(preset: GeminiPreset, rawArgs: Record<string, unknown>): string {
  for (const spec of preset.args) {
    if (spec.required) {
      const v = rawArgs?.[spec.name];
      if (v === undefined || v === null || v === "") {
        throw new Error(`preset "${preset.name}" requires arg: ${spec.name}`);
      }
    }
  }
  return renderPromptTemplate(preset.promptTemplate, rawArgs ?? {});
}

export async function runPreset(
  preset: GeminiPreset,
  rawArgs: Record<string, unknown>,
  opts: { cwd?: string; signal?: AbortSignal } = {},
) {
  const prompt = renderPresetPrompt(preset, rawArgs);
  return await runPrompt({
    prompt,
    model: preset.model,
    approvalMode: preset.approvalMode,
    outputFormat: preset.outputFormat,
    timeoutMs: preset.timeoutMs,
    cwd: opts.cwd,
    signal: opts.signal,
  });
}

export async function runPresetBackground(
  preset: GeminiPreset,
  rawArgs: Record<string, unknown>,
  opts: { cwd?: string } = {},
) {
  const prompt = renderPresetPrompt(preset, rawArgs);
  return await runPromptBackground({
    prompt,
    model: preset.model,
    approvalMode: preset.approvalMode,
    outputFormat: preset.outputFormat,
    timeoutMs: preset.timeoutMs,
    cwd: opts.cwd,
    meta: { subagent: preset.name },
  });
}
