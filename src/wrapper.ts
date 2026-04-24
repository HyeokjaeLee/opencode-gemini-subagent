#!/usr/bin/env bun
import {
  writeFileSync,
  renameSync,
  fsyncSync,
  closeSync,
  openSync,
} from "node:fs";
import path from "node:path";

const TERMINATION_GRACE_MS = 5_000;

const taskDir = process.argv[2];
if (!taskDir || !(await Bun.file(taskDir).stat().catch(() => null))) {
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

async function readJson(target: string): Promise<StateData> {
  return JSON.parse(await Bun.file(target).text()) as StateData;
}

function nowIso(): string {
  return new Date().toISOString();
}

async function classifyTimeoutCause(stderrFilePath: string): Promise<string> {
  try {
    const f = Bun.file(stderrFilePath);
    if (!(await f.exists())) return "unknown";
    const size = f.size;
    if (size === 0) return "silent";
    const readBytes = Math.min(16384, size);
    const tail = await f.slice(size - readBytes, size).text();
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

async function patchState(patch: StateData): Promise<void> {
  let current: StateData = {};
  try {
    current = await readJson(statePath);
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

const spec = (await readJson(specPath)) as unknown as Spec;
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

await patchState({
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
const cancelPoll = setInterval(async () => {
  if (cancelRequested) return;
  if (await Bun.file(cancelPath).exists()) {
    cancelRequested = true;
    patchState({ cancel_requested_at: nowIso() }).catch(() => {});
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

const stdoutText = await Bun.file(stdoutPath).text().catch(() => "");

await Bun.write(resultPath, stdoutText).catch(() => {});

let status: string;
if (cancelRequested) status = "cancelled";
else if (timedOut) status = "timeout";
else if (child.exitCode === 0) status = "completed";
else status = "failed";

const timeoutCause = timedOut ? await classifyTimeoutCause(stderrPath) : null;

const stdoutStat = await Bun.file(stdoutPath).stat().catch(() => null);
const stderrStat = await Bun.file(stderrPath).stat().catch(() => null);

await patchState({
  status,
  exit_code: child.exitCode,
  signal: null,
  timed_out: timedOut,
  cancelled: cancelRequested,
  completed_at: nowIso(),
  result_path: resultPath,
  stdout_bytes: stdoutStat?.size ?? 0,
  stderr_bytes: stderrStat?.size ?? 0,
  timeout_cause: timeoutCause,
});

process.exit(0);
