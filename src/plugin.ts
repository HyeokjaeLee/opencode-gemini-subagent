import type { ToolDefinition, ToolContext } from "@opencode-ai/plugin";
import { runPrompt, runPromptBackground, getStatus } from "./bridge.js";
import { AGENTS_DIR } from "./paths.js";
import {
  loadPresets,
  runPreset,
  runPresetBackground,
  type GeminiPreset,
} from "./presets.js";
import {
  inspectTask,
  readResult,
  readStderr,
  waitForTask,
  cancelTask,
  listTasks,
  sweepOldTasks,
  type TaskSnapshot,
} from "./tasks.js";
import { formatSkillsContext } from "./skills.js";

const { tool } = await import("@opencode-ai/plugin").catch(() => {
  throw new Error(
    "@opencode-ai/plugin not found. This plugin must be loaded from within opencode.",
  );
});

const APPROVAL_MODES = ["default", "auto_edit", "yolo", "plan"] as const;
const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const;
const CONSULT = "consult";

interface SyncResult {
  output: string;
  metadata: Record<string, unknown>;
}

function formatSyncResult(result: { timedOut: boolean; exitCode: number; stdout: string; stderr: string }): SyncResult {
  if (result.timedOut) {
    return {
      output: `Gemini timed out.\n\nPartial stdout:\n${limitResult(result.stdout)}\n\nStderr:\n${limitResult(result.stderr)}`,
      metadata: { timedOut: true },
    };
  }
  if (result.exitCode !== 0) {
    return {
      output: `Gemini exited with code ${result.exitCode}.\n\nStdout:\n${limitResult(result.stdout)}\n\nStderr:\n${limitResult(result.stderr)}`,
      metadata: { exitCode: result.exitCode, failed: true },
    };
  }
  return {
    output: limitResult(result.stdout).trim() || "(empty response)",
    metadata: { exitCode: 0 },
  };
}

function formatBgHandoff(handoff: { task_id: string }, subagent: string): SyncResult {
  return {
    output:
      `Background task launched.\n\n` +
      `task_id: ${handoff.task_id}\n` +
      `subagent: ${subagent}\n\n` +
      `The task runs under its preset's execution budget (see gemini_status).\n` +
      `Poll with gemini_result({ task_id, block?: true, timeout_ms? }). ` +
      `timeout_ms here is the WAIT budget for this single poll, not the task's ` +
      `execution budget. If the wait deadline hits first, you get ` +
      `status="still_running" with progress info — the task keeps going.\n` +
      `Cancel with gemini_cancel({ task_id }).`,
    metadata: { task_id: handoff.task_id, subagent, backgrounded: true },
  };
}

function buildExampleCall(preset: GeminiPreset): string {
  const argEntries = preset.args.map((spec) => {
    const placeholder = spec.required
      ? `"<${spec.name}>"`
      : `"<${spec.name}?>>"`;
    return `  ${spec.name}: ${placeholder}`;
  });
  const lines = [
    `gemini({`,
    `  subagent: "${preset.name}",`,
    ...argEntries,
    `  background: false  // or true for long-running tasks`,
    `})`,
  ];
  return lines.join("\n");
}

function buildPresetArgs(presetsByName: Map<string, GeminiPreset>): Record<string, ReturnType<typeof tool.schema.string>> {
  const presetArgs: Record<string, ReturnType<typeof tool.schema.string>> = {};
  const seen = new Set<string>();
  for (const [, preset] of presetsByName) {
    for (const spec of preset.args) {
      if (seen.has(spec.name)) continue;
      seen.add(spec.name);
      presetArgs[spec.name] = tool.schema
        .string()
        .optional()
        .describe(
          `[preset:${preset.name}] ${spec.description ?? ""}${spec.required ? " (required)" : ""}`,
        );
    }
  }
  return presetArgs;
}

function buildGeminiTool(presetsByName: Map<string, GeminiPreset>): ToolDefinition {
  const presetNames = Array.from(presetsByName.keys());
  const subagentList = [CONSULT, ...presetNames].join(", ");

  const presetGuide = presetNames.length > 0
    ? presetNames.map((n) => {
        const p = presetsByName.get(n)!;
        const argList = p.args.map((a) =>
          `${a.name}${a.required ? " (required)" : " (optional)"}: ${a.description ?? ""}`
        ).join("; ");
        return `  - "${n}": ${p.description}${argList ? ` Args: ${argList}` : ""}`;
      }).join("\n")
    : "  (none loaded)";

  return tool({
    description:
      "Delegate work to Gemini as a subagent. Gemini has built-in web search.\n\n" +
      "SUBAGENTS:\n" +
      `  - "consult" (default): Raw prompt mode. Pass any instruction via 'prompt' arg.\n` +
      `${presetGuide}\n\n` +
      "background=false (default): synchronous — blocks until Gemini responds, returns result directly.\n" +
      "background=true: async — returns task_id immediately. Use gemini_result({ task_id }) to collect later.",
    args: {
      subagent: tool.schema
        .string()
        .optional()
        .describe(
          `Which subagent to run. "consult" (default) = raw prompt. Otherwise a preset name: ${presetNames.join(", ") || "(none loaded)"}`,
        ),
      background: tool.schema
        .boolean()
        .optional()
        .describe(
          "If true, launch detached and return a task_id immediately. Default false (synchronous).",
        ),
      prompt: tool.schema
        .string()
        .optional()
        .describe('Required when subagent="consult". The full prompt to send to Gemini.'),
      model: tool.schema
        .string()
        .optional()
        .describe(
          'Gemini model id (consult only). Default: "gemini-3.1-flash-lite-preview". ' +
          'Options — "gemini-3.1-flash-lite-preview": fastest (~7s), lightweight tasks, web search, fact-checking, summarization. ' +
          '"gemini-3-flash-preview": higher quality reasoning (~15s), complex analysis, code review, but may hit RPM limits under burst. ' +
          '"gemini-2.5-flash": balanced (~10s), stable, good for general-purpose prompts. ' +
          'Omit to use the default model.',
        ),
      approval_mode: tool.schema
        .enum(APPROVAL_MODES as unknown as [string, ...string[]])
        .optional()
        .describe('Approval policy (consult only). Default "plan" = read-only.'),
      output_format: tool.schema
        .enum(OUTPUT_FORMATS as unknown as [string, ...string[]])
        .optional()
        .describe('Output format (consult only). Default "text".'),
      timeout_ms: tool.schema
        .number()
        .int()
        .min(5_000)
        .max(30 * 60_000)
        .optional()
        .describe("Hard timeout in ms (consult only). Default 180000."),
      cwd: tool.schema
        .string()
        .optional()
        .describe("Working directory. Defaults to the opencode session directory."),
      ...buildPresetArgs(presetsByName),
    },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string; metadata: Record<string, unknown> }> {
      const subagent = (args.subagent ?? CONSULT) as string;
      const background = args.background === true;
      const cwd = (args.cwd as string) ?? ctx.directory;

      if (subagent !== CONSULT && !presetsByName.has(subagent)) {
        return {
          output: `Unknown subagent "${subagent}". Available: ${subagentList}`,
          metadata: { failed: true, reason: "unknown_subagent" },
        };
      }

      let prompt = args.prompt as string;
      if (subagent === CONSULT && typeof prompt === "string") {
        const skillsCtx = await formatSkillsContext();
        if (skillsCtx) {
          prompt = `${skillsCtx}\n\n---\n\n${prompt}`;
        }
      }

      if (subagent === CONSULT) {
        if (typeof args.prompt !== "string" || args.prompt.length === 0) {
          return {
            output: 'subagent="consult" requires a non-empty prompt.',
            metadata: { failed: true, reason: "missing_prompt" },
          };
        }
        const common = {
          prompt: prompt!,
          model: args.model as string | undefined,
          approvalMode: (args.approval_mode as "default" | "auto_edit" | "yolo" | "plan" | undefined) ?? "plan",
          outputFormat: (args.output_format as "text" | "json" | "stream-json" | undefined) ?? "text",
          timeoutMs: args.timeout_ms as number | undefined,
          cwd,
        };
        if (background) {
          const handoff = await runPromptBackground({ ...common, meta: { subagent: CONSULT } });
          ctx.metadata({
            title: `gemini/consult (bg ${handoff.task_id})`,
            metadata: { task_id: handoff.task_id, subagent: CONSULT, backgrounded: true },
          });
          return formatBgHandoff(handoff, CONSULT);
        }
        const res = await runPrompt({ ...common, signal: ctx.abort });
        ctx.metadata({
          title: `gemini/consult (${args.model ?? "default"}, ${common.approvalMode})`,
          metadata: { exitCode: res.exitCode, timedOut: res.timedOut },
        });
        return formatSyncResult(res);
      }

      const preset = presetsByName.get(subagent)!;
      const presetArgs: Record<string, unknown> = {};
      for (const spec of preset.args) {
        if (args[spec.name] !== undefined) presetArgs[spec.name] = args[spec.name];
      }
      try {
        if (background) {
          const handoff = await runPresetBackground(preset, presetArgs, { cwd });
          ctx.metadata({
            title: `gemini/${preset.name} (bg ${handoff.task_id})`,
            metadata: { task_id: handoff.task_id, subagent: preset.name, backgrounded: true },
          });
          return formatBgHandoff(handoff, preset.name);
        }
        const res = await runPreset(preset, presetArgs, { cwd, signal: ctx.abort });
        ctx.metadata({
          title: `gemini/${preset.name} (${preset.model ?? "default"}, ${preset.approvalMode})`,
          metadata: { preset: preset.name, exitCode: res.exitCode, timedOut: res.timedOut },
        });
        return formatSyncResult(res);
      } catch (err) {
        return {
          output: `Subagent "${subagent}" failed: ${(err as Error)?.message ?? err}`,
          metadata: { failed: true, subagent },
        };
      }
    },
  });
}

const MAX_RESULT_BYTES = 100 * 1024;

function tailBytes(text: string, maxBytes = 4096): string {
  if (!text) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  return "…" + buf.subarray(buf.byteLength - maxBytes).toString("utf8");
}

function limitResult(text: string, maxBytes = MAX_RESULT_BYTES): string {
  if (!text) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8") + `\n\n... (truncated at ${maxBytes} bytes)`;
}

const geminiResultTool = tool({
  description:
    "Retrieve the state/result of a background Gemini task.\n\n" +
    "timeout_ms here is the WAIT BUDGET for this polling call — NOT the task's " +
    "execution budget. The task itself runs under its own preset timeout_ms " +
    "(see gemini_status). Omitting timeout_ms defaults to the preset's " +
    "execution budget (or 180000ms for consult mode) as a convenience cap.\n\n" +
    'If block=true and the wait deadline hits before the task finishes, the ' +
    'response returns status="still_running" with progress info — this tool ' +
    "NEVER stalls silently. Use block=false to peek without waiting.\n\n" +
    "When a task ends with status=\"timeout\", the response includes " +
    "`timeout_cause` (rate_limit_backoff | network_error | no_progress | silent | unknown) " +
    "to explain why. Live tasks also expose `retry_state`, `retry_reason`, and " +
    "`retry_wait_ms` when Gemini CLI is actively retrying an API error.",
  args: {
    task_id: tool.schema.string().min(1).describe('Task id returned by gemini(..., background: true).'),
    block: tool.schema
      .boolean()
      .optional()
      .describe("If true, wait up to timeout_ms for a terminal state. Default false."),
    timeout_ms: tool.schema
      .number()
      .int()
      .min(100)
      .max(30 * 60_000)
      .optional()
      .describe("Wait budget for THIS polling call. Not the task's execution budget. Omit to default to preset timeout."),
    include_tail: tool.schema
      .boolean()
      .optional()
      .describe("If true, include the last ~4KB of stdout/stderr in the response."),
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string; metadata: Record<string, unknown> }> {
    const block = args.block === true;
    const taskId = args.task_id as string;
    const snapPeek = await inspectTask(taskId);
    const effectiveTimeoutMs = (args.timeout_ms as number) ?? snapPeek.preset_timeout_ms ?? 180_000;

    const snap = block
      ? await waitForTask(taskId, effectiveTimeoutMs)
      : { ...snapPeek, deadline_hit: false };

    if (snap.status === "unknown") {
      return {
        output: `Unknown task_id: ${taskId}`,
        metadata: { failed: true, reason: "unknown_task" },
      };
    }

    const terminal = snap.status === "completed" || snap.status === "failed" || snap.status === "cancelled" || snap.status === "timeout";
    const stillRunning = !terminal;

    let body = "";
    let output = "";
    const metadata: Record<string, unknown> = { ...snap, task_id: taskId };

    if (terminal) {
      const result = await readResult(taskId);
      const stderr = await readStderr(taskId);
      body = limitResult(result ?? "");
      const headerBits = [
        `status: ${snap.status}`,
        `exit: ${snap.exit_code ?? "?"}`,
        `elapsed: ${snap.elapsed_ms ?? "?"}ms`,
      ];
      if (snap.status === "timeout" && snap.timeout_cause) {
        headerBits.push(`timeout_cause: ${snap.timeout_cause}`);
      }
      const header = headerBits.join(" | ");
      output = [header, "", body.trim() || "(empty stdout)"].join("\n");
      if (snap.status === "timeout" && snap.timeout_cause === "rate_limit_backoff") {
        output +=
          "\n\nNOTE: The task hit its execution budget while Gemini CLI was retrying a " +
          "transient rate limit (429). The model was working — it simply exceeded the per-minute " +
          "request quota. Consider raising the preset's timeout_ms, reducing call concurrency, " +
          "or retrying after a short delay.";
      }
      if (snap.status !== "completed") output += `\n\n---stderr---\n${tailBytes(stderr)}`;
    } else {
      const reportedStatus = snap.orphaned ? "orphaned" : "still_running";
      metadata.status = reportedStatus;
      const retryBits: string[] = [];
      if (snap.retry_state) {
        retryBits.push(
          `retry_state: ${snap.retry_state} (${snap.retry_reason ?? "unknown"})` +
            (snap.retry_wait_ms != null ? `, backing off ~${snap.retry_wait_ms}ms` : ""),
        );
      }
      const lines = [
        `status: ${reportedStatus}`,
        `task_id: ${taskId}`,
        `subagent: ${snap.subagent ?? "(unknown)"}`,
        `elapsed_ms: ${snap.elapsed_ms ?? "?"}`,
        snap.remaining_execution_ms != null
          ? `remaining_execution_ms: ${snap.remaining_execution_ms} (task kill budget; separate from this wait)`
          : "",
        `stdout_bytes: ${snap.stdout_bytes ?? 0}`,
        `stderr_bytes: ${snap.stderr_bytes ?? 0}`,
        ...retryBits,
        snap.deadline_hit ? `NOTE: wait deadline (${effectiveTimeoutMs}ms) hit before completion. Task is still running.` : "",
        snap.orphaned
          ? "WARNING: wrapper process is no longer alive. Task is orphaned; cancel or re-run."
          : "",
        "",
        "Call gemini_result again with a longer timeout_ms, or gemini_cancel to stop.",
      ].filter(Boolean);
      output = lines.join("\n");

      if (args.include_tail) {
        const [so, se] = await Promise.all([readResult(taskId), readStderr(taskId)]);
        output += `\n\n---stdout tail---\n${tailBytes(so ?? "")}`;
        output += `\n\n---stderr tail---\n${tailBytes(se)}`;
      }
    }

    ctx.metadata({
      title: `gemini_result ${taskId} [${metadata.status}]`,
      metadata: {
        task_id: taskId,
        status: metadata.status,
        elapsed_ms: snap.elapsed_ms,
        stillRunning,
        deadline_hit: snap.deadline_hit ?? false,
      },
    });
    return { output, metadata };
  },
});

const geminiCancelTool = tool({
  description:
    "Cancel a running background Gemini task. Sends SIGTERM to the process group, " +
    "waits ~5s for graceful shutdown, then SIGKILL if needed. Returns the final status.",
  args: {
    task_id: tool.schema.string().min(1).describe("Task id to cancel."),
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string; metadata: Record<string, unknown> }> {
    const taskId = args.task_id as string;
    const snap = await cancelTask(taskId);
    if (snap.status === "unknown") {
      return {
        output: `Unknown task_id: ${taskId}`,
        metadata: { failed: true, reason: "unknown_task" },
      };
    }
    ctx.metadata({
      title: `gemini_cancel ${taskId} [${snap.status}]`,
      metadata: { task_id: taskId, status: snap.status },
    });
    return {
      output:
        `status: ${snap.status}\n` +
        `elapsed_ms: ${snap.elapsed_ms ?? "?"}\n` +
        `exit_code: ${snap.exit_code ?? "-"}\n` +
        `signal: ${snap.signal ?? "-"}`,
      metadata: snap as unknown as Record<string, unknown>,
    };
  },
});

export const GeminiSubagentPlugin = async () => {
  const { presets, errors } = await loadPresets();
  if (errors.length > 0) {
    for (const e of errors) {
      console.warn(`[ogs] skipping invalid preset ${e.file}: ${e.message}`);
    }
  }

  sweepOldTasks().catch((e) =>
    console.warn(`[ogs] sweepOldTasks failed: ${(e as Error)?.message ?? e}`),
  );

  const presetsByName = new Map(presets.map((p) => [p.name, p]));

  const tools = {
    gemini: buildGeminiTool(presetsByName),
    gemini_result: geminiResultTool,
    gemini_cancel: geminiCancelTool,
    gemini_status: tool({
      description:
        "Report installation, auth, MCP, preset, and background task status of the isolated Gemini bridge. " +
        "Use this to discover available presets, their args, and how to call them (via example_call). " +
        "Use this first if any gemini_* tool fails, to verify the sandbox is set up.",
      args: {},
      async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<{ output: string }> {
        const [s, tasks] = await Promise.all([getStatus(), listTasks()]);
        const full = {
          ...s,
          agentsDir: AGENTS_DIR,
          presets: presets.map((p) => ({
            name: p.name,
            description: p.description,
            model: p.model,
            approvalMode: p.approvalMode,
            timeoutMs: p.timeoutMs,
            args: p.args,
            filePath: p.filePath,
            example_call: buildExampleCall(p),
          })),
          presetLoadErrors: errors,
          tasks,
        };
        ctx.metadata({
          title: "gemini bridge status",
          metadata: {
            authenticated: s.authenticated,
            binExists: s.binExists,
            mcpServerCount: s.mcpServers.length,
            presetCount: presets.length,
            taskCount: tasks.length,
          },
        });
        return { output: JSON.stringify(full, null, 2) };
      },
    }),
  };

  return { tool: tools };
};

export default GeminiSubagentPlugin;
