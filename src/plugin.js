/**
 * opencode plugin that exposes the isolated Gemini CLI as a set of tools.
 *
 * All Gemini state (OAuth, MCP servers, history, settings, task files) is
 * confined to ~/.ogs/sandbox. The global ~/.gemini install is never read or written.
 *
 * Gemini CLI is installed directly in ~/.ogs/ (no npx) with auto-updates.
 *
 * Two distinct timeout budgets:
 *   - Preset `timeout_ms` (frontmatter) = EXECUTION budget. Wrapper SIGTERMs
 *     the gemini process when this elapses. Finalized status becomes "timeout"
 *     with `timeout_cause` annotated (rate_limit_backoff | network_error |
 *     no_progress | silent | unknown).
 *   - `gemini_result({ timeout_ms })` = WAIT budget for a single polling call.
 *     Does not affect the task itself. Missing the wait deadline returns
 *     status="still_running"; the task continues under its own execution budget.
 *
 * Live (non-terminal) tasks also surface `retry_state`, `retry_reason`, and
 * `retry_wait_ms` from stderr-tail heuristics when Gemini CLI is actively
 * retrying an API-side rate limit (HTTP 429, MODEL_CAPACITY_EXHAUSTED,
 * rateLimitExceeded, quota reset hints). Other failure modes (network
 * errors, etc.) are classified separately as `timeout_cause` only after
 * the wrapper terminates the task, not via live retry_state.
 *
 * Tool surface:
 *   gemini          single entry point; subagent="consult" (default) or a preset name
 *   gemini_result   poll/wait for a background task; exposes timeout_cause & retry_state
 *   gemini_cancel   SIGTERM → grace → SIGKILL a running task
 *   gemini_status   installation/auth/preset/task snapshot (includes example_call per preset)
 */

const { tool } = await import("@opencode-ai/plugin").catch(() => {
  throw new Error(
    "@opencode-ai/plugin not found. This plugin must be loaded from within opencode.",
  );
});
import { runPrompt, runPromptBackground, getStatus } from "./bridge.mjs";
import { AGENTS_DIR } from "./paths.mjs";
import {
  loadPresets,
  runPreset,
  runPresetBackground,
} from "./presets.mjs";
import {
  inspectTask,
  readResult,
  readStderr,
  waitForTask,
  cancelTask,
  listTasks,
  sweepOldTasks,
} from "./tasks.mjs";
import { formatSkillsContext } from "./skills.mjs";

const APPROVAL_MODES = ["default", "auto_edit", "yolo", "plan"];
const OUTPUT_FORMATS = ["text", "json", "stream-json"];
const CONSULT = "consult";

function formatSyncResult(result) {
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

function formatBgHandoff({ task_id }, subagent) {
  return {
    output:
      `Background task launched.\n\n` +
      `task_id: ${task_id}\n` +
      `subagent: ${subagent}\n\n` +
      `The task runs under its preset's execution budget (see gemini_status).\n` +
      `Poll with gemini_result({ task_id, block?: true, timeout_ms? }). ` +
      `timeout_ms here is the WAIT budget for this single poll, not the task's ` +
      `execution budget. If the wait deadline hits first, you get ` +
      `status="still_running" with progress info — the task keeps going.\n` +
      `Cancel with gemini_cancel({ task_id }).`,
    metadata: { task_id, subagent, backgrounded: true },
  };
}

function buildExampleCall(preset) {
  const argEntries = preset.args.map((spec) => {
    const placeholder = spec.required
      ? `"<${spec.name}>"`
      : `"<${spec.name}?>"`;
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

function buildPresetArgs(presetsByName) {
  const presetArgs = {};
  const seen = new Set();
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

function buildGeminiTool(presetsByName) {
  const presetNames = Array.from(presetsByName.keys());
  const subagentList = [CONSULT, ...presetNames].join(", ");

  const presetGuide = presetNames.length > 0
    ? presetNames.map((n) => {
        const p = presetsByName.get(n);
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
        .enum(APPROVAL_MODES)
        .optional()
        .describe('Approval policy (consult only). Default "plan" = read-only.'),
      output_format: tool.schema
        .enum(OUTPUT_FORMATS)
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
    async execute(args, ctx) {
      const subagent = (args.subagent ?? CONSULT).trim();
      const background = args.background === true;
      const cwd = args.cwd ?? ctx.directory;

      if (subagent !== CONSULT && !presetsByName.has(subagent)) {
        return {
          output: `Unknown subagent "${subagent}". Available: ${subagentList}`,
          metadata: { failed: true, reason: "unknown_subagent" },
        };
      }

      let prompt = args.prompt;
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
          prompt,
          model: args.model,
          approvalMode: args.approval_mode ?? "plan",
          outputFormat: args.output_format ?? "text",
          timeoutMs: args.timeout_ms,
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

      const preset = presetsByName.get(subagent);
      const presetArgs = {};
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
          output: `Subagent "${subagent}" failed: ${err?.message ?? err}`,
          metadata: { failed: true, subagent },
        };
      }
    },
  });
}

const MAX_RESULT_BYTES = 100 * 1024;

function tailBytes(text, maxBytes = 4096) {
  if (!text) return "";
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  return "…" + buf.subarray(buf.byteLength - maxBytes).toString("utf8");
}

function limitResult(text, maxBytes = MAX_RESULT_BYTES) {
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
  async execute(args, ctx) {
    const block = args.block === true;
    const snapPeek = await inspectTask(args.task_id);
    const effectiveTimeoutMs = args.timeout_ms ?? snapPeek.preset_timeout_ms ?? 180_000;

    const snap = block
      ? await waitForTask(args.task_id, effectiveTimeoutMs)
      : { ...snapPeek, deadline_hit: false };

    if (snap.status === "unknown") {
      return {
        output: `Unknown task_id: ${args.task_id}`,
        metadata: { failed: true, reason: "unknown_task" },
      };
    }

    const terminal = snap.status === "completed" || snap.status === "failed" || snap.status === "cancelled" || snap.status === "timeout";
    const stillRunning = !terminal;

    let body = "";
    let output = "";
    let metadata = { ...snap, task_id: args.task_id };

    if (terminal) {
      const result = await readResult(args.task_id);
      const stderr = await readStderr(args.task_id);
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
      const retryBits = [];
      if (snap.retry_state) {
        retryBits.push(
          `retry_state: ${snap.retry_state} (${snap.retry_reason ?? "unknown"})` +
            (snap.retry_wait_ms != null ? `, backing off ~${snap.retry_wait_ms}ms` : ""),
        );
      }
      const lines = [
        `status: ${reportedStatus}`,
        `task_id: ${args.task_id}`,
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
        const [so, se] = await Promise.all([readResult(args.task_id), readStderr(args.task_id)]);
        output += `\n\n---stdout tail---\n${tailBytes(so ?? "")}`;
        output += `\n\n---stderr tail---\n${tailBytes(se)}`;
      }
    }

    ctx.metadata({
      title: `gemini_result ${args.task_id} [${metadata.status}]`,
      metadata: {
        task_id: args.task_id,
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
  async execute(args, ctx) {
    const snap = await cancelTask(args.task_id);
    if (snap.status === "unknown") {
      return {
        output: `Unknown task_id: ${args.task_id}`,
        metadata: { failed: true, reason: "unknown_task" },
      };
    }
    ctx.metadata({
      title: `gemini_cancel ${args.task_id} [${snap.status}]`,
      metadata: { task_id: args.task_id, status: snap.status },
    });
    return {
      output:
        `status: ${snap.status}\n` +
        `elapsed_ms: ${snap.elapsed_ms ?? "?"}\n` +
        `exit_code: ${snap.exit_code ?? "-"}\n` +
        `signal: ${snap.signal ?? "-"}`,
      metadata: snap,
    };
  },
});

export const GeminiSubagentPlugin = async () => {
  const { syncBundledAgents } = await import("./installer.mjs");
  syncBundledAgents();

  const { presets, errors } = await loadPresets();
  if (errors.length > 0) {
    for (const e of errors) {
      console.warn(`[ogs] skipping invalid preset ${e.file}: ${e.message}`);
    }
  }

  sweepOldTasks().catch((e) =>
    console.warn(`[ogs] sweepOldTasks failed: ${e?.message ?? e}`),
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
      async execute(_args, ctx) {
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
