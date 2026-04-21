import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  GEMINI_BIN,
  GEMINI_HOME,
  GEMINI_OAUTH_CREDS_PATH,
  GEMINI_SANDBOX,
  GEMINI_SETTINGS_PATH,
  GEMINI_GLOBAL_HOME,
  NPM_CACHE_DIR,
  OGS_ROOT,
  assertNotGlobal,
} from "./paths.mjs";
import { ensureInstalled } from "./installer.mjs";

/**
 * Public API.
 *
 * @typedef {Object} RunOptions
 * @property {string}   prompt        User prompt (appended via stdin; safe for any length).
 * @property {string}   [model]       Gemini model id, e.g. "gemini-2.5-pro".
 * @property {"default"|"auto_edit"|"yolo"|"plan"} [approvalMode]
 *                                    Approval policy. Defaults to "plan" (read-only) for safety.
 * @property {"text"|"json"|"stream-json"} [outputFormat]  Default "text".
 * @property {string}   [cwd]         Working directory for Gemini. Defaults to cwd().
 * @property {number}   [timeoutMs]   Hard kill timeout. Defaults to 180_000.
 * @property {string[]} [extraArgs]   Extra raw CLI args (advanced).
 * @property {AbortSignal} [signal]   External cancellation.
 * @property {Record<string, string>} [env]  Extra env vars merged over the sandboxed env.
 *
 * @typedef {Object} RunResult
 * @property {number}  exitCode
 * @property {string}  stdout
 * @property {string}  stderr
 * @property {boolean} timedOut
 * @property {string[]} argv
 */

export function buildSandboxedEnv(extraEnv = {}) {
  assertNotGlobal(GEMINI_SANDBOX);
  const base = { ...process.env };
  // Neutralise ambient overrides that could leak global credentials into the sandbox.
  delete base.GEMINI_API_KEY_FILE;
  delete base.GOOGLE_APPLICATION_CREDENTIALS;
  // HOME override is the isolation primitive: Gemini CLI hardcodes $HOME/.gemini.
  base.HOME = GEMINI_SANDBOX;
  base.XDG_CONFIG_HOME = GEMINI_SANDBOX;
  // Redirect npm/npx caches so MCP servers launched via `npx ...` do not pollute ~/.npm.
  base.npm_config_cache = NPM_CACHE_DIR;
  base.NPM_CONFIG_CACHE = NPM_CACHE_DIR;
  return { ...base, ...extraEnv };
}

export async function ensureSandbox() {
  await mkdir(GEMINI_HOME, { recursive: true });
  await mkdir(NPM_CACHE_DIR, { recursive: true });
}

/**
 * Spawn the isolated Gemini CLI with the given argv and optional stdin.
 * Automatically ensures Gemini CLI is installed and up-to-date.
 *
 * @param {string[]} argv
 * @param {{ stdin?: string, cwd?: string, timeoutMs?: number, signal?: AbortSignal, env?: Record<string,string>, inheritStdio?: boolean }} [opts]
 * @returns {Promise<RunResult>}
 */
export async function spawnGemini(argv, opts = {}) {
  ensureInstalled({ silent: true });
  await ensureSandbox();

  const env = buildSandboxedEnv(opts.env);
  const cwd = opts.cwd ?? process.cwd();
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const inheritStdio = opts.inheritStdio ?? false;

  return await new Promise((resolve, reject) => {
    const child = spawn(GEMINI_BIN, argv, {
      cwd,
      env,
      stdio: inheritStdio
        ? ["inherit", "inherit", "inherit"]
        : ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer = null;

    if (!inheritStdio) {
      child.stdout?.on("data", (chunk) => (stdout += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    }

    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    killTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      // Grace period before SIGKILL so graceful shutdown can finish first.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 5_000);
    }, timeoutMs);

    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
        argv: [GEMINI_BIN, ...argv],
      });
    });

    if (!inheritStdio && opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    } else if (!inheritStdio) {
      child.stdin?.end();
    }
  });
}

/**
 * Run a headless prompt against the isolated Gemini. Prompt is sent via stdin
 * (not argv) to avoid shell-length and escaping issues.
 *
 * @param {RunOptions} options
 * @returns {Promise<RunResult>}
 */
export async function runPrompt(options) {
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

/**
 * Build the argv (excluding binary) that `runPrompt` would use. Exposed so
 * that the background task manager can reconstruct an equivalent invocation
 * under a supervisor without duplicating the flag-assembly logic here.
 */
export function buildPromptArgv({ approvalMode = "plan", outputFormat = "text", model, extraArgs = [] } = {}) {
  const argv = ["--prompt", "", "--approval-mode", approvalMode, "--output-format", outputFormat];
  if (model) argv.push("--model", model);
  argv.push(...extraArgs);
  return argv;
}

/**
 * Launch a background gemini task via the detached wrapper supervisor.
 * Returns immediately with the task_id; the wrapper owns the gemini
 * subprocess for its entire lifetime and persists the result to disk.
 *
 * @param {RunOptions & { meta?: Record<string, unknown> }} options
 * @returns {Promise<{ task_id: string, task_dir: string }>}
 */
export async function runPromptBackground(options) {
  const { prompt, model, approvalMode = "plan", outputFormat = "text", cwd, timeoutMs, extraArgs = [], env, meta } = options;
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("runPromptBackground: `prompt` is required.");
  }
  ensureInstalled({ silent: true });
  await ensureSandbox();
  const { startTask } = await import("./tasks.mjs");
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

/**
 * Run a Gemini subcommand (e.g. ["mcp","list"], ["auth"]) inheriting stdio so
 * interactive flows (OAuth, MCP auth) work in the user's terminal.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, timeoutMs?: number, env?: Record<string,string> }} [opts]
 */
export async function runInteractive(argv, opts = {}) {
  return await spawnGemini(argv, {
    ...opts,
    inheritStdio: true,
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
  });
}

export async function getStatus() {
  const binExists = existsSync(GEMINI_BIN);

  let authenticated = false;
  try {
    if (existsSync(GEMINI_OAUTH_CREDS_PATH)) {
      const raw = await readFile(GEMINI_OAUTH_CREDS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      authenticated = Boolean(parsed?.access_token || parsed?.refresh_token);
    }
  } catch {}

  let mcpServers = [];
  try {
    if (existsSync(GEMINI_SETTINGS_PATH)) {
      const raw = await readFile(GEMINI_SETTINGS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      mcpServers = Object.keys(parsed?.mcpServers ?? {});
    }
  } catch {}

  let version = null;
  if (binExists) {
    try {
      const res = await spawnGemini(["--version"], { timeoutMs: 10_000 });
      version = res.stdout.trim() || null;
    } catch {}
  }

  // Also check installed npm version
  let npmVersion = null;
  try {
    const pkgPath = `${OGS_ROOT}/node_modules/@google/gemini-cli/package.json`;
    if (existsSync(pkgPath)) {
      const raw = await readFile(pkgPath, "utf8");
      npmVersion = JSON.parse(raw).version ?? null;
    }
  } catch {}

  return {
    ogsRoot: OGS_ROOT,
    sandbox: GEMINI_SANDBOX,
    sandboxExists: existsSync(GEMINI_SANDBOX),
    geminiHome: GEMINI_HOME,
    geminiHomeExists: existsSync(GEMINI_HOME),
    settingsPath: GEMINI_SETTINGS_PATH,
    npmCacheDir: NPM_CACHE_DIR,
    bin: GEMINI_BIN,
    binExists,
    version,
    npmPackageVersion: npmVersion,
    authenticated,
    mcpServers,
    globalHomeIgnored: GEMINI_GLOBAL_HOME,
  };
}

export async function resetSandbox() {
  assertNotGlobal(GEMINI_SANDBOX);
  if (existsSync(GEMINI_SANDBOX)) {
    await rm(GEMINI_SANDBOX, { recursive: true, force: true });
  }
  await ensureSandbox();
}
