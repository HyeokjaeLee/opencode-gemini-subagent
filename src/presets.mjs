import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { AGENTS_DIR } from "./paths.mjs";
import { runPrompt, runPromptBackground } from "./bridge.mjs";

const VALID_APPROVAL = new Set(["default", "auto_edit", "yolo", "plan"]);
const VALID_FORMAT = new Set(["text", "json", "stream-json"]);
const NAME_RE = /^[a-z0-9][a-z0-9_-]*$/i;

/**
 * @typedef {Object} PresetArgSpec
 * @property {string} name
 * @property {string} [description]
 * @property {boolean} [required]
 *
 * @typedef {Object} GeminiPreset
 * @property {string} name                 Tool-safe identifier (file basename).
 * @property {string} toolName             "gemini_" + name.
 * @property {string} filePath
 * @property {string} description          Required; surfaced as the tool description.
 * @property {string} promptTemplate       Markdown body (post-frontmatter).
 * @property {PresetArgSpec[]} args
 * @property {string} [model]
 * @property {"default"|"auto_edit"|"yolo"|"plan"} approvalMode
 * @property {"text"|"json"|"stream-json"} outputFormat
 * @property {number} timeoutMs
 */

function splitFrontmatter(raw) {
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

function validateArgs(rawArgs) {
  if (rawArgs === undefined) return [];
  if (!Array.isArray(rawArgs)) {
    throw new Error("`args` must be a list");
  }
  const seen = new Set();
  const out = [];
  for (const entry of rawArgs) {
    if (!entry || typeof entry !== "object") {
      throw new Error("each `args` entry must be an object");
    }
    const { name, description, required } = entry;
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

/**
 * Parse a single preset file. Throws on invalid frontmatter; the caller is
 * responsible for logging & skipping so one bad file never breaks the rest.
 *
 * @param {string} filePath
 * @returns {Promise<GeminiPreset>}
 */
export async function parsePresetFile(filePath) {
  const raw = await readFile(filePath, "utf8");
  const { yaml, body } = splitFrontmatter(raw);

  let fm;
  try {
    fm = parseYaml(yaml) ?? {};
  } catch (err) {
    throw new Error(`YAML parse error: ${err.message}`);
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

  const approvalMode = fm.approval_mode ?? "plan";
  if (!VALID_APPROVAL.has(approvalMode)) {
    throw new Error(
      `invalid approval_mode (got ${JSON.stringify(approvalMode)})`,
    );
  }

  const outputFormat = fm.output_format ?? "text";
  if (!VALID_FORMAT.has(outputFormat)) {
    throw new Error(
      `invalid output_format (got ${JSON.stringify(outputFormat)})`,
    );
  }

  const timeoutMs =
    typeof fm.timeout_ms === "number" && Number.isFinite(fm.timeout_ms)
      ? fm.timeout_ms
      : 180_000;

  const model = typeof fm.model === "string" ? fm.model : undefined;

  return {
    name: basename,
    toolName: `gemini_${basename}`,
    filePath,
    description,
    promptTemplate: body,
    args: validateArgs(fm.args),
    model,
    approvalMode,
    outputFormat,
    timeoutMs,
  };
}

/**
 * Scan AGENTS_DIR for *.md presets. Invalid files are reported via `errors`
 * and skipped; they do NOT abort loading of valid siblings.
 *
 * @returns {Promise<{ presets: GeminiPreset[], errors: Array<{ file: string, message: string }> }>}
 */
export async function loadPresets() {
  if (!existsSync(AGENTS_DIR)) {
    return { presets: [], errors: [] };
  }
  const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
  const presets = [];
  const errors = [];
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    const filePath = path.join(AGENTS_DIR, ent.name);
    try {
      presets.push(await parsePresetFile(filePath));
    } catch (err) {
      errors.push({ file: filePath, message: err?.message ?? String(err) });
    }
  }
  presets.sort((a, b) => a.name.localeCompare(b.name));
  return { presets, errors };
}

/**
 * Replace `{{name}}` occurrences in the template with the corresponding value.
 * Missing values become empty strings (preset body is responsible for making
 * sense when an optional arg is absent).
 */
export function renderPromptTemplate(template, values) {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_m, k) => {
    const v = values[k];
    if (v === undefined || v === null) return "";
    return String(v);
  });
}

/**
 * Run a preset end-to-end: render prompt, enforce required args, call Gemini.
 *
 * @param {GeminiPreset} preset
 * @param {Record<string, unknown>} rawArgs
 * @param {{ cwd?: string, signal?: AbortSignal }} [opts]
 */
function renderPresetPrompt(preset, rawArgs) {
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

export async function runPreset(preset, rawArgs, opts = {}) {
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

export async function runPresetBackground(preset, rawArgs, opts = {}) {
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
