import { existsSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import {
  GEMINI_BIN,
  GEMINI_HOME,
  GEMINI_OAUTH_CREDS_PATH,
  GEMINI_SANDBOX,
  GEMINI_SETTINGS_PATH,
  GEMINI_GLOBAL_HOME,
  OGS_ROOT,
  assertNotGlobal,
} from "./paths.js";
import { ensureInstalled } from "./installer.js";

export interface RunOptions {
  prompt: string;
  model?: string;
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  outputFormat?: "text" | "json" | "stream-json";
  cwd?: string;
  timeoutMs?: number;
  extraArgs?: string[];
  signal?: AbortSignal;
  env?: Record<string, string>;
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  argv: string[];
}

interface SpawnOpts {
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: Record<string, string>;
  inheritStdio?: boolean;
}

export function buildSandboxedEnv(extraEnv: Record<string, string> = {}): Record<string, string | undefined> {
  assertNotGlobal(GEMINI_SANDBOX);
  const base: Record<string, string | undefined> = { ...Bun.env };
  delete base.GEMINI_API_KEY_FILE;
  delete base.GOOGLE_APPLICATION_CREDENTIALS;
  base.HOME = GEMINI_SANDBOX;
  base.XDG_CONFIG_HOME = GEMINI_SANDBOX;
  return { ...base, ...extraEnv };
}

export async function ensureSandbox(): Promise<void> {
  await mkdir(GEMINI_HOME, { recursive: true });
}

export async function spawnGemini(argv: string[], opts: SpawnOpts = {}): Promise<RunResult> {
  await ensureInstalled({ silent: true });
  await ensureSandbox();

  const env = buildSandboxedEnv(opts.env);
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const inheritStdio = opts.inheritStdio ?? false;

  const stdinInput = (!inheritStdio && opts.stdin !== undefined) ? opts.stdin : undefined;

  const proc = Bun.spawn([GEMINI_BIN, ...argv], {
    cwd,
    env,
    stdin: inheritStdio ? "inherit" : (stdinInput !== undefined ? new TextEncoder().encode(stdinInput) : "pipe"),
    stdout: inheritStdio ? "inherit" : "pipe",
    stderr: inheritStdio ? "inherit" : "pipe",
  });

  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const onAbort = () => {
    try { proc.kill(); } catch (_e) { /* ignore */ }
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  killTimer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch (_e) { /* ignore */ }
    setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch (_e) { /* ignore */ }
    }, 5_000);
  }, timeoutMs);

  let stdout = "";
  let stderr = "";

  if (!inheritStdio) {
    const [stdoutText, stderrText] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    stdout = stdoutText;
    stderr = stderrText;
  }

  await proc.exited;

  if (killTimer) clearTimeout(killTimer);
  opts.signal?.removeEventListener("abort", onAbort);

  return {
    exitCode: proc.exitCode ?? -1,
    stdout,
    stderr,
    timedOut,
    argv: [GEMINI_BIN, ...argv],
  };
}

export async function runPrompt(options: RunOptions): Promise<RunResult> {
  const {
    prompt,
    model,
    approvalMode = "plan",
    outputFormat = "text",
    cwd,
    timeoutMs,
    extraArgs = [],
    signal,
    env,
  } = options;
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("runPrompt: `prompt` is required.");
  }

  const argv = buildPromptArgv({ approvalMode, outputFormat, model, extraArgs });

  return await spawnGemini(argv, {
    stdin: prompt,
    cwd,
    timeoutMs,
    signal,
    env,
  });
}

export function buildPromptArgv(opts: {
  approvalMode?: "default" | "auto_edit" | "yolo" | "plan";
  outputFormat?: "text" | "json" | "stream-json";
  model?: string;
  extraArgs?: string[];
} = {}): string[] {
  const { approvalMode = "plan", outputFormat = "text", model, extraArgs = [] } = opts;
  const argv = ["--prompt", "", "--approval-mode", approvalMode, "--output-format", outputFormat];
  if (model) argv.push("--model", model);
  argv.push(...extraArgs);
  return argv;
}

export async function runPromptBackground(options: RunOptions & { meta?: Record<string, unknown> }): Promise<{ task_id: string; task_dir: string }> {
  const { prompt, model, approvalMode = "plan", outputFormat = "text", cwd, timeoutMs, extraArgs = [], env, meta } = options;
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("runPromptBackground: `prompt` is required.");
  }
  ensureInstalled({ silent: true });
  await ensureSandbox();
  const { startTask } = await import("./tasks.js");
  const argv = [GEMINI_BIN, ...buildPromptArgv({ approvalMode, outputFormat, model, extraArgs })];
  return await startTask({
    argv,
    env: buildSandboxedEnv(env),
    cwd: cwd ?? process.cwd(),
    stdin: prompt,
    timeoutMs,
    meta: { ...meta, model },
  });
}

export async function runInteractive(argv: string[], opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}): Promise<RunResult> {
  return await spawnGemini(argv, {
    ...opts,
    inheritStdio: true,
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
  });
}

export interface GeminiStatus {
  ogsRoot: string;
  sandbox: string;
  sandboxExists: boolean;
  geminiHome: string;
  geminiHomeExists: boolean;
  settingsPath: string;
  bin: string;
  binExists: boolean;
  version: string | null;
  packageVersion: string | null;
  authenticated: boolean;
  mcpServers: string[];
  globalHomeIgnored: string;
}

export async function getStatus(): Promise<GeminiStatus> {
  const binExists = existsSync(GEMINI_BIN);

  let authenticated = false;
  try {
    if (existsSync(GEMINI_OAUTH_CREDS_PATH)) {
      const raw = await Bun.file(GEMINI_OAUTH_CREDS_PATH).text();
      const parsed = JSON.parse(raw) as { access_token?: string; refresh_token?: string };
      authenticated = Boolean(parsed?.access_token || parsed?.refresh_token);
    }
  } catch (_e) { /* ignore */ }

  let mcpServers: string[] = [];
  try {
    if (existsSync(GEMINI_SETTINGS_PATH)) {
      const raw = await Bun.file(GEMINI_SETTINGS_PATH).text();
      const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
      mcpServers = Object.keys(parsed?.mcpServers ?? {});
    }
  } catch (_e) { /* ignore */ }

  let version: string | null = null;
  if (binExists) {
    try {
      const res = await spawnGemini(["--version"], { timeoutMs: 10_000 });
      version = res.stdout.trim() || null;
    } catch (_e) { /* ignore */ }
  }

  let pkgVersion: string | null = null;
  try {
    const pkgPath = `${OGS_ROOT}/node_modules/@google/gemini-cli/package.json`;
    if (existsSync(pkgPath)) {
      const raw = await Bun.file(pkgPath).text();
      pkgVersion = (JSON.parse(raw) as { version?: string }).version ?? null;
    }
  } catch (_e) { /* ignore */ }

  return {
    ogsRoot: OGS_ROOT,
    sandbox: GEMINI_SANDBOX,
    sandboxExists: existsSync(GEMINI_SANDBOX),
    geminiHome: GEMINI_HOME,
    geminiHomeExists: existsSync(GEMINI_HOME),
    settingsPath: GEMINI_SETTINGS_PATH,
    bin: GEMINI_BIN,
    binExists,
    version,
    packageVersion: pkgVersion,
    authenticated,
    mcpServers,
    globalHomeIgnored: GEMINI_GLOBAL_HOME,
  };
}

export async function resetSandbox(): Promise<void> {
  assertNotGlobal(GEMINI_SANDBOX);
  if (existsSync(GEMINI_SANDBOX)) {
    rmSync(GEMINI_SANDBOX, { recursive: true, force: true });
  }
  await ensureSandbox();
}
