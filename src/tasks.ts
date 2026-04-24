import { existsSync, openSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { TASKS_DIR } from "./paths.js";

const WRAPPER_PATH = path.join(import.meta.dir, "wrapper.js");

const BUN_BIN: string = process.execPath;

const TASK_ID_RE = /^gem_[0-9a-f-]{36}$/;
const TERMINAL_RETENTION_MS = 72 * 60 * 60_000;

function taskDirFor(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(`invalid task_id format: ${taskId}`);
  }
  return path.join(TASKS_DIR, taskId);
}

async function ensureTasksRoot(): Promise<void> {
  await mkdir(TASKS_DIR, { recursive: true, mode: 0o700 });
}

interface TaskState {
  task_id?: string;
  status?: string;
  subagent?: string | null;
  model?: string | null;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  completed_at?: string | null;
  timeout_ms?: number | null;
  wrapper_pid?: number;
  wrapper_started?: string | null;
  exit_code?: number | null;
  signal?: string | null;
  timed_out?: boolean;
  cancelled?: boolean;
  cancel_requested_at?: string;
  spawn_error?: string;
  result_path?: string | null;
  stdout_bytes?: number;
  stderr_bytes?: number;
  timeout_cause?: string | null;
  [key: string]: unknown;
}

async function readState(taskId: string): Promise<TaskState | null> {
  const p = path.join(taskDirFor(taskId), "state.json");
  if (!(await Bun.file(p).exists())) return null;
  try {
    return JSON.parse(await Bun.file(p).text()) as TaskState;
  } catch (_e) {
    await new Promise((r) => setTimeout(r, 50));
    try { return JSON.parse(await Bun.file(p).text()) as TaskState; }
    catch (_e2) { return null; }
  }
}

async function isProcessAlive(pid: number, expectedStart?: string | null): Promise<boolean> {
  try {
    process.kill(pid, 0);
  } catch (_e) {
    return false;
  }
  if (!expectedStart) return true;
  return new Promise((resolve) => {
    const ps = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...Bun.env, LC_ALL: "C", LC_TIME: "C", LANG: "C" },
    });
    let out = "";
    (async () => {
      out = await new Response(ps.stdout).text();
      await ps.exited;
      resolve(out.trim() === expectedStart.trim());
    })().catch(() => resolve(false));
  });
}

async function captureProcessStart(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    const ps = Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...Bun.env, LC_ALL: "C", LC_TIME: "C", LANG: "C" },
    });
    (async () => {
      const out = await new Response(ps.stdout).text();
      await ps.exited;
      resolve(out.trim() || null);
    })().catch(() => resolve(null));
  });
}

export interface StartTaskOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdin?: string;
  timeoutMs?: number;
  meta?: Record<string, unknown>;
}

export async function startTask(options: StartTaskOptions): Promise<{ task_id: string; task_dir: string }> {
  await ensureTasksRoot();

  const taskId = `gem_${crypto.randomUUID()}`;
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
  await Bun.write(path.join(taskDir, "spec.json"), JSON.stringify(spec, null, 2));

  const initialState: TaskState = {
    task_id: taskId,
    status: "starting",
    subagent: options.meta?.subagent as string ?? null,
    model: options.meta?.model as string ?? null,
    created_at: spec.spawnedAt,
    updated_at: spec.spawnedAt,
    timeout_ms: spec.timeoutMs,
  };
  await Bun.write(path.join(taskDir, "state.json"), JSON.stringify(initialState, null, 2));

  const wrapperErrFd = openSync(path.join(taskDir, "wrapper.err"), "a", 0o600);
  const wrapper = Bun.spawn([BUN_BIN, WRAPPER_PATH, taskDir], {
    detached: true,
    stdin: "ignore",
    stdout: wrapperErrFd,
    stderr: wrapperErrFd,
    cwd: options.cwd,
  });
  wrapper.unref();

  const wrapperStart = await captureProcessStart(wrapper.pid);

  const bootState: TaskState = {
    ...initialState,
    status: "running",
    wrapper_pid: wrapper.pid,
    wrapper_started: wrapperStart,
    updated_at: new Date().toISOString(),
  };
  await Bun.write(path.join(taskDir, "state.json"), JSON.stringify(bootState, null, 2));

  return { task_id: taskId, task_dir: taskDir };
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "timeout";
}

async function statBytes(p: string): Promise<number> {
  try {
    const s = await stat(p);
    return s.size;
  } catch (_e) {
    return 0;
  }
}

export interface TaskSnapshot {
  task_id: string;
  status: string;
  subagent: string | null;
  model: string | null;
  created_at: string | undefined;
  started_at: string | undefined;
  completed_at: string | null;
  updated_at: string | undefined;
  elapsed_ms: number | null;
  stdout_bytes: number;
  stderr_bytes: number;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  cancelled: boolean;
  orphaned: boolean;
  result_path: string | null;
  preset_timeout_ms: number | null;
  execution_deadline_at: string | null;
  remaining_execution_ms: number | null;
  retry_state: string | null;
  retry_reason: string | null;
  retry_wait_ms: number | null;
  timeout_cause: string | null;
  deadline_hit?: boolean;
}

export async function inspectTask(taskId: string): Promise<TaskSnapshot> {
  const state = await readState(taskId);
  if (!state) return { task_id: taskId, status: "unknown" } as TaskSnapshot;

  const dir = taskDirFor(taskId);
  const stdoutBytes = await statBytes(path.join(dir, "stdout"));
  const stderrBytes = await statBytes(path.join(dir, "stderr"));
  const startedAt = state.started_at || state.created_at;
  const endAnchor = state.completed_at ? new Date(state.completed_at).getTime() : Date.now();
  const elapsedMs = startedAt ? endAnchor - new Date(startedAt).getTime() : null;

  let orphaned = false;
  if (!isTerminal(state.status ?? "") && state.wrapper_pid) {
    const alive = await isProcessAlive(state.wrapper_pid as number, state.wrapper_started as string | null);
    if (!alive) orphaned = true;
  }

  let executionDeadlineAt: string | null = null;
  let remainingExecutionMs: number | null = null;
  if (startedAt && typeof state.timeout_ms === "number") {
    const deadline = new Date(startedAt).getTime() + state.timeout_ms;
    executionDeadlineAt = new Date(deadline).toISOString();
    if (!isTerminal(state.status ?? "")) {
      remainingExecutionMs = Math.max(0, deadline - Date.now());
    }
  }

  let retryState: { state: string; reason: string; wait_ms: number | null } | null = null;
  if (!isTerminal(state.status ?? "")) {
    const tail = await readTail(path.join(dir, "stderr"), 8192);
    retryState = detectRetryState(tail);
  }

  return {
    task_id: taskId,
    status: state.status ?? "unknown",
    subagent: state.subagent ?? null,
    model: state.model ?? null,
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

export async function readResult(taskId: string): Promise<string | null> {
  const dir = taskDirFor(taskId);
  const p = path.join(dir, "result.txt");
  if (!(await Bun.file(p).exists())) return null;
  return await Bun.file(p).text();
}

export async function readStderr(taskId: string): Promise<string> {
  const dir = taskDirFor(taskId);
  const p = path.join(dir, "stderr");
  if (!(await Bun.file(p).exists())) return "";
  return await Bun.file(p).text();
}

async function readTail(filePath: string, maxBytes: number): Promise<string> {
  if (!(await Bun.file(filePath).exists())) return "";
  try {
    const s = await stat(filePath);
    const size = s.size;
    if (size === 0) return "";
    if (size <= maxBytes) return await Bun.file(filePath).text();
    const fd = await (await import("node:fs/promises")).open(filePath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      await fd.read(buf, 0, maxBytes, size - maxBytes);
      return buf.toString("utf8");
    } finally {
      await fd.close();
    }
  } catch (_e) {
    return "";
  }
}

function detectRetryState(stderrTail: string): { state: string; reason: string; wait_ms: number | null } | null {
  if (!stderrTail) return null;

  const signals = [
    { re: /model_capacity_exhausted/i, reason: "model_capacity_exhausted" },
    { re: /ratelimitexceeded/i, reason: "rate_limit_exceeded" },
    { re: /quota will reset after (\d+)s/i, reason: "quota_exhausted" },
    { re: /status[:\s]+429/i, reason: "http_429" },
    { re: /resource_exhausted/i, reason: "resource_exhausted" },
  ];

  let matched: { reason: string; match: RegExpMatchArray } | null = null;
  for (const sig of signals) {
    const m = stderrTail.match(sig.re);
    if (m) {
      matched = { reason: sig.reason, match: m };
      break;
    }
  }
  if (!matched) return null;

  let waitMs: number | null = null;
  const retryAfter = [...stderrTail.matchAll(/retrying after (\d+)ms/gi)].pop();
  if (retryAfter) waitMs = Number(retryAfter[1]);
  if (waitMs == null) {
    const resetAfter = [...stderrTail.matchAll(/reset after (\d+)s/gi)].pop();
    if (resetAfter) waitMs = Number(resetAfter[1]) * 1000;
  }

  return {
    state: "rate_limited",
    reason: matched.reason,
    wait_ms: Number.isFinite(waitMs as number) ? waitMs : null,
  };
}

export async function waitForTask(taskId: string, timeoutMs: number): Promise<TaskSnapshot & { deadline_hit?: boolean }> {
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

export async function cancelTask(taskId: string, opts: { waitMs?: number } = {}): Promise<TaskSnapshot> {
  const { waitMs = 6_000 } = opts;
  const dir = taskDirFor(taskId);
  const state = await readState(taskId);
  if (!state) return { task_id: taskId, status: "unknown" } as TaskSnapshot;
  if (isTerminal(state.status ?? "")) return await inspectTask(taskId);

  await Bun.write(path.join(dir, "cancel.request"), new Date().toISOString());

  const finalSnap = await waitForTask(taskId, waitMs);
  return finalSnap;
}

export async function listTasks(): Promise<TaskSnapshot[]> {
  if (!(await Bun.file(TASKS_DIR).exists())) return [];
  const entries = await readdir(TASKS_DIR, { withFileTypes: true });
  const tasks: TaskSnapshot[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!TASK_ID_RE.test(e.name)) continue;
    try {
      tasks.push(await inspectTask(e.name));
    } catch (_e) { /* skip corrupt tasks */ }
  }
  tasks.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return tasks;
}

export async function sweepOldTasks(): Promise<{ swept: number }> {
  if (!(await Bun.file(TASKS_DIR).exists())) return { swept: 0 };
  const entries = await readdir(TASKS_DIR, { withFileTypes: true });
  const now = Date.now();
  let swept = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!TASK_ID_RE.test(e.name)) continue;
    const state = await readState(e.name);
    if (!state) continue;
    if (!isTerminal(state.status ?? "")) continue;
    const completed = new Date(state.completed_at ?? state.updated_at ?? "").getTime();
    if (Number.isFinite(completed) && now - completed > TERMINAL_RETENTION_MS) {
      try {
        await rm(path.join(TASKS_DIR, e.name), { recursive: true, force: true });
        swept++;
      } catch (_e) { /* ignore */ }
    }
  }
  return { swept };
}
