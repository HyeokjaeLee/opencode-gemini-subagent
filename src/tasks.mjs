/**
 * Background task manager. Tasks are spawned as detached wrapper processes
 * that own the gemini subprocess and finalize state when it exits. This way
 * a task survives opencode restarts.
 *
 * Layout: <OGS_ROOT>/tasks/<task_id>/
 *   spec.json       launch spec (argv/env/cwd/stdin/timeoutMs)
 *   state.json      current status (atomically rewritten by wrapper)
 *   stdout          captured stdout
 *   stderr          captured stderr
 *   result.txt      final stdout text (set when wrapper finalizes)
 *   cancel.request  sentinel file (created by cancelTask)
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TASKS_DIR } from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRAPPER_PATH = path.join(__dirname, "wrapper.mjs");

/**
 * Locate the real Node binary. opencode embeds its own runtime and exposes it
 * as `process.execPath`, but that binary dispatches to the opencode CLI, not a
 * generic node REPL. Spawning a detached wrapper with it would re-enter
 * opencode. We resolve a true `node` via `which node`, falling back to common
 * install paths.
 */
const NODE_BIN = (() => {
  const fromEnv = process.env.OGS_NODE_BIN;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const r = spawnSync("which", ["node"], { encoding: "utf8" });
    const p = r.stdout?.trim();
    if (p && existsSync(p)) return p;
  } catch {}
  for (const candidate of [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    `${process.env.HOME}/Library/pnpm/nodejs/bin/node`,
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return process.execPath;
})();

const TASK_ID_RE = /^gem_[0-9a-f-]{36}$/;
const TERMINAL_RETENTION_MS = 72 * 60 * 60 * 1_000;

function taskDirFor(taskId) {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`invalid task_id format: ${taskId}`);
  }
  return path.join(TASKS_DIR, taskId);
}

async function ensureTasksRoot() {
  await mkdir(TASKS_DIR, { recursive: true, mode: 0o700 });
}

async function readState(taskId) {
  const p = path.join(taskDirFor(taskId), "state.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8"));
  } catch {
    // State file is being rewritten. Brief retry before giving up.
    await new Promise((r) => setTimeout(r, 50));
    try { return JSON.parse(await readFile(p, "utf8")); }
    catch { return null; }
  }
}

/**
 * PID liveness check that also guards against PID reuse by comparing the
 * recorded start time (via `ps -o lstart=`) to the one we captured at spawn.
 * On failure to verify, treats the process as dead — safer to report orphan
 * than to leave a task stuck in "running".
 */
async function isProcessAlive(pid, expectedStart) {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (!expectedStart) return true;
  return new Promise((resolve) => {
    const ps = spawn("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", LC_TIME: "C", LANG: "C" },
    });
    let out = "";
    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.on("close", () => resolve(out.trim() === expectedStart.trim()));
    ps.on("error", () => resolve(false));
  });
}

async function captureProcessStart(pid) {
  return new Promise((resolve) => {
    const ps = spawn("ps", ["-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, LC_ALL: "C", LC_TIME: "C", LANG: "C" },
    });
    let out = "";
    ps.stdout.on("data", (d) => (out += d.toString()));
    ps.on("close", () => resolve(out.trim() || null));
    ps.on("error", () => resolve(null));
  });
}

/**
 * Launch a gemini invocation as a detached background task.
 *
 * @param {Object} options
 * @param {string[]} options.argv   Full argv for gemini (including "--prompt" etc).
 * @param {Object} options.env      Environment for the gemini process.
 * @param {string} options.cwd
 * @param {string} [options.stdin]
 * @param {number} [options.timeoutMs]
 * @param {Object} [options.meta]   Extra metadata to embed in state (e.g. subagent name).
 * @returns {Promise<{ task_id: string, task_dir: string }>}
 */
export async function startTask(options) {
  await ensureTasksRoot();

  const taskId = `gem_${randomUUID()}`;
  const taskDir = taskDirFor(taskId);
  await mkdir(taskDir, { recursive: true, mode: 0o700 });

  const spec = {
    argv: options.argv,
    env: options.env,
    cwd: options.cwd,
    stdin: options.stdin ?? "",
    timeoutMs: options.timeoutMs ?? 180_000,
    spawnedAt: new Date().toISOString(),
  };
  await writeFile(path.join(taskDir, "spec.json"), JSON.stringify(spec, null, 2), {
    mode: 0o600,
  });

  const initialState = {
    task_id: taskId,
    status: "starting",
    subagent: options.meta?.subagent ?? null,
    model: options.meta?.model ?? null,
    created_at: spec.spawnedAt,
    updated_at: spec.spawnedAt,
    timeout_ms: spec.timeoutMs,
  };
  await writeFile(path.join(taskDir, "state.json"), JSON.stringify(initialState, null, 2), {
    mode: 0o600,
  });

  const wrapperErrFd = openSync(path.join(taskDir, "wrapper.err"), "a", 0o600);
  const wrapper = spawn(NODE_BIN, [WRAPPER_PATH, taskDir], {
    detached: true,
    stdio: ["ignore", wrapperErrFd, wrapperErrFd],
    cwd: options.cwd,
  });
  wrapper.unref();

  // Capture wrapper's real start time to defend against PID reuse on
  // later orphan checks.
  const wrapperStart = await captureProcessStart(wrapper.pid);

  const bootState = {
    ...initialState,
    status: "running",
    wrapper_pid: wrapper.pid,
    wrapper_started: wrapperStart,
    updated_at: new Date().toISOString(),
  };
  await writeFile(path.join(taskDir, "state.json"), JSON.stringify(bootState, null, 2), {
    mode: 0o600,
  });

  return { task_id: taskId, task_dir: taskDir };
}

function isTerminal(status) {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timeout";
}

async function statBytes(p) {
  try {
    const s = await stat(p);
    return s.size;
  } catch {
    return 0;
  }
}

/**
 * Fetch current task state with progress snapshot. If the wrapper process has
 * disappeared but state is still "running", the task is flagged `orphaned: true`.
 */
export async function inspectTask(taskId) {
  const state = await readState(taskId);
  if (!state) return { task_id: taskId, status: "unknown" };

  const dir = taskDirFor(taskId);
  const stdoutBytes = await statBytes(path.join(dir, "stdout"));
  const stderrBytes = await statBytes(path.join(dir, "stderr"));
  const startedAt = state.started_at || state.created_at;
  const endAnchor = state.completed_at ? new Date(state.completed_at).getTime() : Date.now();
  const elapsedMs = startedAt ? endAnchor - new Date(startedAt).getTime() : null;

  let orphaned = false;
  if (!isTerminal(state.status) && state.wrapper_pid) {
    const alive = await isProcessAlive(state.wrapper_pid, state.wrapper_started);
    if (!alive) orphaned = true;
  }

  // Execution budget bookkeeping. `preset_timeout_ms` is the wrapper's hard
  // kill budget (from spec.timeoutMs). These fields let callers distinguish
  // the wait budget of gemini_result from the execution budget of the task.
  let executionDeadlineAt = null;
  let remainingExecutionMs = null;
  if (startedAt && typeof state.timeout_ms === "number") {
    const deadline = new Date(startedAt).getTime() + state.timeout_ms;
    executionDeadlineAt = new Date(deadline).toISOString();
    if (!isTerminal(state.status)) {
      remainingExecutionMs = Math.max(0, deadline - Date.now());
    }
  }

  // Advisory: scan stderr tail only for live tasks. Terminal tasks already
  // have `timeout_cause` recorded by the wrapper if it was a timeout.
  let retryState = null;
  if (!isTerminal(state.status)) {
    const tail = await readTail(path.join(dir, "stderr"), 8192);
    retryState = detectRetryState(tail);
  }

  return {
    task_id: taskId,
    status: state.status,
    subagent: state.subagent,
    model: state.model,
    created_at: state.created_at,
    started_at: startedAt,
    completed_at: state.completed_at ?? null,
    updated_at: state.updated_at,
    elapsed_ms: elapsedMs,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    exit_code: state.exit_code ?? null,
    signal: state.signal ?? null,
    timed_out: state.timed_out ?? false,
    cancelled: state.cancelled ?? false,
    orphaned,
    result_path: state.result_path ?? null,
    preset_timeout_ms: state.timeout_ms ?? null,
    execution_deadline_at: executionDeadlineAt,
    remaining_execution_ms: remainingExecutionMs,
    retry_state: retryState?.state ?? null,
    retry_reason: retryState?.reason ?? null,
    retry_wait_ms: retryState?.wait_ms ?? null,
    timeout_cause: state.timeout_cause ?? null,
  };
}

/**
 * Load the full result text (from result.txt) if the task completed.
 * Returns null if not yet terminal.
 */
export async function readResult(taskId) {
  const dir = taskDirFor(taskId);
  const p = path.join(dir, "result.txt");
  if (!existsSync(p)) return null;
  return await readFile(p, "utf8");
}

export async function readStderr(taskId) {
  const dir = taskDirFor(taskId);
  const p = path.join(dir, "stderr");
  if (!existsSync(p)) return "";
  return await readFile(p, "utf8");
}

/**
 * Read at most `maxBytes` from the end of a file. Used for cheap tail-scanning
 * the stderr log for retry/rate-limit signals without loading the whole file.
 */
async function readTail(filePath, maxBytes) {
  if (!existsSync(filePath)) return "";
  try {
    const s = await stat(filePath);
    const size = s.size;
    if (size === 0) return "";
    if (size <= maxBytes) return await readFile(filePath, "utf8");
    const fd = await (await import("node:fs/promises")).open(filePath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      await fd.read(buf, 0, maxBytes, size - maxBytes);
      return buf.toString("utf8");
    } finally {
      await fd.close();
    }
  } catch {
    return "";
  }
}

/**
 * Advisory scan of a stderr tail for Gemini-CLI retry markers. Fail-open:
 * returns null (no signal) rather than throwing. Never used to make lifecycle
 * decisions — only to annotate the snapshot so callers can distinguish
 * "dead" from "alive, retrying under rate limit".
 */
function detectRetryState(stderrTail) {
  if (!stderrTail) return null;

  const signals = [
    { re: /model_capacity_exhausted/i, reason: "model_capacity_exhausted" },
    { re: /ratelimitexceeded/i, reason: "rate_limit_exceeded" },
    { re: /quota will reset after (\d+)s/i, reason: "quota_exhausted" },
    { re: /status[:\s]+429/i, reason: "http_429" },
    { re: /resource_exhausted/i, reason: "resource_exhausted" },
  ];

  let matched = null;
  for (const sig of signals) {
    const m = stderrTail.match(sig.re);
    if (m) {
      matched = { reason: sig.reason, match: m };
      break;
    }
  }
  if (!matched) return null;

  // Look for the most recent "Retrying after <N>ms" or "reset after <N>s" hint
  // in the tail. Both forms come from Gemini CLI's retry loop.
  let waitMs = null;
  const retryAfter = [...stderrTail.matchAll(/retrying after (\d+)ms/gi)].pop();
  if (retryAfter) waitMs = Number(retryAfter[1]);
  if (waitMs == null) {
    const resetAfter = [...stderrTail.matchAll(/reset after (\d+)s/gi)].pop();
    if (resetAfter) waitMs = Number(resetAfter[1]) * 1000;
  }

  return {
    state: "rate_limited",
    reason: matched.reason,
    wait_ms: Number.isFinite(waitMs) ? waitMs : null,
  };
}

/**
 * Wait up to timeoutMs for the task to reach a terminal state. Returns the
 * final inspect snapshot. If the deadline hits, returns `{ ...snapshot,
 * deadline_hit: true }` with still-running data — never silently stalls.
 */
export async function waitForTask(taskId, timeoutMs) {
  if (typeof timeoutMs !== "number" || timeoutMs <= 0) {
    throw new Error("waitForTask: timeoutMs must be a positive number");
  }
  const deadline = Date.now() + timeoutMs;
  let pollMs = 100;
  for (;;) {
    const snap = await inspectTask(taskId);
    if (snap.status === "unknown") return { ...snap, deadline_hit: false };
    if (isTerminal(snap.status) || snap.orphaned) return { ...snap, deadline_hit: false };
    const remain = deadline - Date.now();
    if (remain <= 0) return { ...snap, deadline_hit: true };
    await new Promise((r) => setTimeout(r, Math.min(pollMs, remain)));
    pollMs = Math.min(pollMs * 1.5, 1_000);
  }
}

/**
 * Request cancellation. Writes a sentinel file the wrapper polls; wrapper
 * sends SIGTERM to the process group, then SIGKILL after a grace period.
 * Blocks up to waitMs (default 6s) for terminal status, so callers get a
 * clear outcome instead of an ambiguous "cancel_requested".
 */
export async function cancelTask(taskId, { waitMs = 6_000 } = {}) {
  const dir = taskDirFor(taskId);
  const state = await readState(taskId);
  if (!state) return { task_id: taskId, status: "unknown" };
  if (isTerminal(state.status)) return await inspectTask(taskId);

  await writeFile(path.join(dir, "cancel.request"), new Date().toISOString(), {
    mode: 0o600,
  });

  const finalSnap = await waitForTask(taskId, waitMs);
  return finalSnap;
}

/**
 * List all known tasks with their current snapshot. Sorted newest-first.
 */
export async function listTasks() {
  if (!existsSync(TASKS_DIR)) return [];
  const entries = await readdir(TASKS_DIR, { withFileTypes: true });
  const tasks = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!TASK_ID_RE.test(e.name)) continue;
    try {
      tasks.push(await inspectTask(e.name));
    } catch {}
  }
  tasks.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return tasks;
}

/**
 * Delete terminal tasks older than TERMINAL_RETENTION_MS. Called at plugin
 * startup and on new task creation (not on result fetch, which must stay
 * deterministic for callers).
 */
export async function sweepOldTasks() {
  if (!existsSync(TASKS_DIR)) return { swept: 0 };
  const entries = await readdir(TASKS_DIR, { withFileTypes: true });
  const now = Date.now();
  let swept = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!TASK_ID_RE.test(e.name)) continue;
    const state = await readState(e.name);
    if (!state) continue;
    if (!isTerminal(state.status)) continue;
    const completed = new Date(state.completed_at ?? state.updated_at).getTime();
    if (Number.isFinite(completed) && now - completed > TERMINAL_RETENTION_MS) {
      try {
        await rm(path.join(TASKS_DIR, e.name), { recursive: true, force: true });
        swept++;
      } catch {}
    }
  }
  return { swept };
}
