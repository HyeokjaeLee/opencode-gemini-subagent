#!/usr/bin/env node
/**
 * Background task supervisor. Runs as a detached child of the plugin.
 * Owns the gemini subprocess and finalizes the task state file on exit,
 * so that tasks survive opencode restarts.
 *
 * Invocation:
 *   node wrapper.mjs <task_dir>
 * where <task_dir>/spec.json contains { argv, env, cwd, stdin, timeoutMs, spawnedAt }.
 */

import { spawn } from "node:child_process";
import { createWriteStream, openSync, writeFileSync, readFileSync, renameSync, fsyncSync, closeSync, existsSync, statSync, openSync as openSyncFs, readSync, closeSync as closeSyncFs } from "node:fs";
import path from "node:path";

const TERMINATION_GRACE_MS = 5_000;

const taskDir = process.argv[2];
if (!taskDir || !existsSync(taskDir)) {
  console.error(`wrapper: task_dir missing or does not exist: ${taskDir}`);
  process.exit(2);
}

const specPath = path.join(taskDir, "spec.json");
const statePath = path.join(taskDir, "state.json");
const stdoutPath = path.join(taskDir, "stdout");
const stderrPath = path.join(taskDir, "stderr");
const resultPath = path.join(taskDir, "result.txt");

function writeJsonAtomic(target, data) {
  const tmp = `${target}.${process.pid}.tmp`;
  const payload = JSON.stringify(data, null, 2);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, payload);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

function readJson(target) {
  return JSON.parse(readFileSync(target, "utf8"));
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * On timeout, read the tail of stderr and classify the cause. Used only for
 * diagnostic annotation (timeout_cause); never drives lifecycle.
 */
function classifyTimeoutCause(stderrPath) {
  try {
    if (!existsSync(stderrPath)) return "unknown";
    const s = statSync(stderrPath);
    const size = s.size;
    if (size === 0) return "silent";
    const readBytes = Math.min(16384, size);
    const buf = Buffer.alloc(readBytes);
    const fd = openSyncFs(stderrPath, "r");
    try {
      readSync(fd, buf, 0, readBytes, size - readBytes);
    } finally {
      closeSyncFs(fd);
    }
    const tail = buf.toString("utf8");
    if (/MODEL_CAPACITY_EXHAUSTED|rateLimitExceeded|quota will reset after|RESOURCE_EXHAUSTED|status[:\s]+429/i.test(tail)) {
      return "rate_limit_backoff";
    }
    if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED/i.test(tail)) {
      return "network_error";
    }
    return "no_progress";
  } catch {
    return "unknown";
  }
}

function patchState(patch) {
  let current = {};
  try {
    current = readJson(statePath);
  } catch {}
  writeJsonAtomic(statePath, { ...current, ...patch, updated_at: nowIso() });
}

const spec = readJson(specPath);
const { argv, env, cwd, stdin, timeoutMs } = spec;

const stdoutStream = createWriteStream(stdoutPath, { flags: "w", mode: 0o600 });
const stderrStream = createWriteStream(stderrPath, { flags: "w", mode: 0o600 });

await Promise.all([
  new Promise((r) => stdoutStream.once("open", r)),
  new Promise((r) => stderrStream.once("open", r)),
]);

const startedAt = nowIso();
const child = spawn(argv[0], argv.slice(1), {
  cwd,
  env,
  stdio: ["pipe", "pipe", "pipe"],
  detached: true,
});

child.stdout.pipe(stdoutStream);
child.stderr.pipe(stderrStream);

patchState({
  status: "running",
  child_pid: child.pid,
  started_at: startedAt,
});

if (typeof stdin === "string" && stdin.length > 0) {
  child.stdin.end(stdin);
} else {
  child.stdin.end();
}

let timedOut = false;
let hardKillTimer = null;
const softKillTimer = setTimeout(() => {
  timedOut = true;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  hardKillTimer = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try { child.kill("SIGKILL"); } catch {}
    }
  }, TERMINATION_GRACE_MS);
}, timeoutMs ?? 180_000);

const cancelPath = path.join(taskDir, "cancel.request");
let cancelRequested = false;
const cancelPoll = setInterval(() => {
  if (cancelRequested) return;
  if (existsSync(cancelPath)) {
    cancelRequested = true;
    patchState({ cancel_requested_at: nowIso() });
    try { process.kill(-child.pid, "SIGTERM"); }
    catch { try { child.kill("SIGTERM"); } catch {} }
    hardKillTimer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch {} }
    }, TERMINATION_GRACE_MS);
  }
}, 200);

child.on("close", (code, signal) => {
  clearTimeout(softKillTimer);
  if (hardKillTimer) clearTimeout(hardKillTimer);
  clearInterval(cancelPoll);

  stdoutStream.end();
  stderrStream.end();

  let stdoutText = "";
  try { stdoutText = readFileSync(stdoutPath, "utf8"); } catch {}

  try {
    writeFileSync(resultPath, stdoutText, { mode: 0o600 });
  } catch {}

  let status;
  if (cancelRequested) status = "cancelled";
  else if (timedOut) status = "timeout";
  else if (code === 0) status = "completed";
  else status = "failed";

  // Advisory cause annotation for timeouts. Separate from the status so the
  // terminal state machine (isTerminal()) stays unchanged.
  const timeoutCause = timedOut ? classifyTimeoutCause(stderrPath) : null;

  patchState({
    status,
    exit_code: code,
    signal,
    timed_out: timedOut,
    cancelled: cancelRequested,
    completed_at: nowIso(),
    result_path: resultPath,
    stdout_bytes: stdoutStream.bytesWritten,
    stderr_bytes: stderrStream.bytesWritten,
    timeout_cause: timeoutCause,
  });

  process.exit(0);
});

child.on("error", (err) => {
  clearTimeout(softKillTimer);
  if (hardKillTimer) clearTimeout(hardKillTimer);
  clearInterval(cancelPoll);
  stdoutStream.end();
  stderrStream.end();
  patchState({
    status: "failed",
    spawn_error: err?.message ?? String(err),
    completed_at: nowIso(),
  });
  process.exit(1);
});
