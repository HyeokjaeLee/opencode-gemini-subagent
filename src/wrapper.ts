#!/usr/bin/env bun
import {
  writeFileSync,
  readFileSync,
  renameSync,
  fsyncSync,
  closeSync,
  openSync,
  existsSync,
  statSync,
  readSync,
} from "node:fs";
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

interface StateData {
  [key: string]: unknown;
}

function writeJsonAtomic(target: string, data: StateData): void {
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

function readJson(target: string): StateData {
  return JSON.parse(readFileSync(target, "utf8")) as StateData;
}

function nowIso(): string {
  return new Date().toISOString();
}

function classifyTimeoutCause(stderrFilePath: string): string {
  try {
    if (!existsSync(stderrFilePath)) return "unknown";
    const s = statSync(stderrFilePath);
    const size = s.size;
    if (size === 0) return "silent";
    const readBytes = Math.min(16384, size);
    const buf = Buffer.alloc(readBytes);
    const fd = openSync(stderrFilePath, "r");
    try {
      readSync(fd, buf, 0, readBytes, size - readBytes);
    } finally {
      closeSync(fd);
    }
    const tail = buf.toString("utf8");
    if (/MODEL_CAPACITY_EXHAUSTED|rateLimitExceeded|quota will reset after|RESOURCE_EXHAUSTED|status[:\s]+429/i.test(tail)) {
      return "rate_limit_backoff";
    }
    if (/ETIMEDOUT|ECONNRESET|ENOTFOUND|ECONNREFUSED/i.test(tail)) {
      return "network_error";
    }
    return "no_progress";
  } catch (_e) {
    return "unknown";
  }
}

function patchState(patch: StateData): void {
  let current: StateData = {};
  try {
    current = readJson(statePath);
  } catch (_e) { /* ignore */ }
  writeJsonAtomic(statePath, { ...current, ...patch, updated_at: nowIso() });
}

interface Spec {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: string;
  timeoutMs: number;
  spawnedAt: string;
}

const spec = readJson(specPath) as unknown as Spec;
const { argv, env, cwd, stdin, timeoutMs } = spec;

const startedAt = nowIso();
const child = Bun.spawn(argv, {
  cwd,
  env: env as Record<string, string>,
  stdin: (typeof stdin === "string" && stdin.length > 0) ? new TextEncoder().encode(stdin) : "pipe",
  stdout: "pipe",
  stderr: "pipe",
  detached: true,
});

patchState({
  status: "running",
  child_pid: child.pid,
  started_at: startedAt,
});

let timedOut = false;
let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
const softKillTimer = setTimeout(() => {
  timedOut = true;
  try {
    process.kill(-child.pid!, "SIGTERM");
  } catch (_e) {
    try { child.kill(); } catch (_e2) { /* ignore */ }
  }
  hardKillTimer = setTimeout(() => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch (_e) {
      try { child.kill("SIGKILL"); } catch (_e2) { /* ignore */ }
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
    try { process.kill(-child.pid!, "SIGTERM"); }
    catch (_e) { try { child.kill(); } catch (_e2) { /* ignore */ } }
    hardKillTimer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); }
      catch (_e) { try { child.kill("SIGKILL"); } catch (_e2) { /* ignore */ } }
    }, TERMINATION_GRACE_MS);
  }
}, 200);

const stdoutWrite = Bun.write(stdoutPath, new Response(child.stdout));
const stderrWrite = Bun.write(stderrPath, new Response(child.stderr));

try {
  await Promise.all([stdoutWrite, stderrWrite, child.exited]);
} catch (_e) {
  try { await child.exited; } catch (_e2) { /* ignore */ }
}

clearTimeout(softKillTimer);
if (hardKillTimer) clearTimeout(hardKillTimer);
clearInterval(cancelPoll);

let stdoutText = "";
try { stdoutText = readFileSync(stdoutPath, "utf8"); } catch (_e) { /* ignore */ }

try {
  writeFileSync(resultPath, stdoutText, { mode: 0o600 });
} catch (_e) { /* ignore */ }

let status: string;
if (cancelRequested) status = "cancelled";
else if (timedOut) status = "timeout";
else if (child.exitCode === 0) status = "completed";
else status = "failed";

const timeoutCause = timedOut ? classifyTimeoutCause(stderrPath) : null;

patchState({
  status,
  exit_code: child.exitCode,
  signal: null,
  timed_out: timedOut,
  cancelled: cancelRequested,
  completed_at: nowIso(),
  result_path: resultPath,
  stdout_bytes: existsSync(stdoutPath) ? statSync(stdoutPath).size : 0,
  stderr_bytes: existsSync(stderrPath) ? statSync(stderrPath).size : 0,
  timeout_cause: timeoutCause,
});

process.exit(0);
