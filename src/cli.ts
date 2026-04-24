#!/usr/bin/env bun
import { getStatus, runInteractive, resetSandbox, ensureSandbox } from "./bridge.js";
import { install, updateIfNeeded, isInstalled, getInstalledVersion, getLatestVersion } from "./installer.js";
import { listTasks, sweepOldTasks } from "./tasks.js";
import { loadPresets } from "./presets.js";
import { GEMINI_BIN, OGS_ROOT, GEMINI_SANDBOX, GEMINI_SETTINGS_PATH } from "./paths.js";
import { existsSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

async function main(): Promise<void> {
  switch (cmd) {
    case "status":
      return cmdStatus();
    case "auth":
      return cmdAuth();
    case "auth:reset":
      return cmdAuthReset();
    case "install":
      return cmdInstall();
    case "update":
      return cmdUpdate();
    case "tasks":
      return cmdTasks();
    case "mcp":
      return cmdMcp();
    case "doctor":
      return cmdDoctor();
    case "help":
    default:
      return cmdHelp();
  }
}

async function cmdStatus(): Promise<void> {
  const s = await getStatus();
  const { presets, errors } = await loadPresets();
  const tasks = await listTasks();

  console.log("OGS Status");
  console.log("──────────");
  console.log(`  ogs root:      ${s.ogsRoot}`);
  console.log(`  sandbox:       ${s.sandbox} ${s.sandboxExists ? "✓" : "✗"}`);
  console.log(`  gemini home:   ${s.geminiHome} ${s.geminiHomeExists ? "✓" : "✗"}`);
  console.log(`  bin:           ${s.bin} ${s.binExists ? "✓" : "✗"}`);
  console.log(`  cli version:   ${s.version ?? "(not installed)"}`);
  console.log(`  pkg version:   ${s.packageVersion ?? "(not installed)"}`);
  console.log(`  authenticated: ${s.authenticated ? "✓" : "✗"}`);
  console.log(`  mcp servers:   ${s.mcpServers.length > 0 ? s.mcpServers.join(", ") : "(none)"}`);
  console.log(`  presets:       ${presets.length} loaded`);
  if (errors.length > 0) {
    for (const e of errors) console.log(`    ⚠ ${e.file}: ${e.message}`);
  }
  console.log(`  tasks:         ${tasks.length} (${tasks.filter((t) => t.status === "running").length} running)`);
  console.log(`  global ignored:${s.globalHomeIgnored}`);
}

async function cmdAuth(): Promise<void> {
  console.log("Launching Gemini OAuth in isolated sandbox...");
  await ensureSandbox();
  const res = await runInteractive(["auth"], { timeoutMs: 10 * 60_000 });
  process.exit(res.exitCode);
}

async function cmdAuthReset(): Promise<void> {
  console.log("Resetting sandbox...");
  await resetSandbox();
  console.log("Sandbox reset. Run `ogs auth` to re-authenticate.");
}

async function cmdInstall(): Promise<void> {
  console.log("Installing @google/gemini-cli in", OGS_ROOT);
  const version = await install({ silent: false });
  console.log(`Installed: ${version}`);
}

async function cmdUpdate(): Promise<void> {
  console.log("Checking for updates...");
  const result = await updateIfNeeded({ silent: false });
  if (result.updated) {
    console.log(`Updated: ${result.from ?? "(new)"} → ${result.to}`);
  } else {
    console.log(`Already up-to-date: ${result.to}`);
  }
}

async function cmdTasks(): Promise<void> {
  const sub = args[1];
  const tasks = await listTasks();

  if (sub === "clean" || sub === "sweep") {
    const { swept } = await sweepOldTasks();
    console.log(`Swept ${swept} old terminal tasks.`);
    return;
  }

  if (tasks.length === 0) {
    console.log("No tasks.");
    return;
  }

  for (const t of tasks) {
    const icon =
      t.status === "running" ? "⏳" :
      t.status === "completed" ? "✓" :
      t.status === "failed" ? "✗" :
      t.status === "cancelled" ? "⊘" :
      t.status === "timeout" ? "⏱" : "?";
    console.log(
      `  ${icon} ${t.task_id}  ${t.status}  ${t.subagent ?? ""}  ${t.elapsed_ms != null ? t.elapsed_ms + "ms" : ""}`,
    );
  }
}

interface McpServerConfig {
  url?: string;
  command?: string;
  disabled?: boolean;
}

interface SettingsFile {
  security?: { auth?: { selectedType?: string } };
  mcpServers?: Record<string, McpServerConfig>;
}

async function cmdMcp(): Promise<void> {
  const sub = args[1];
  if (!sub) {
    console.log("Usage: ogs mcp <list|add|remove|auth> [args...]");
    return;
  }

  if (sub === "list") {
    const settings = await readSettings();
    const servers = settings?.mcpServers ?? {};
    const names = Object.keys(servers);
    if (names.length === 0) {
      console.log("No MCP servers configured.");
    } else {
      for (const [name, cfg] of Object.entries(servers)) {
        const url = cfg.url ?? cfg.command ?? "";
        const disabled = cfg.disabled ? " (disabled)" : "";
        console.log(`  ${name}: ${url}${disabled}`);
      }
    }
  } else if (sub === "add") {
    const mcpArgs = args.slice(2);
    if (mcpArgs.length < 2) {
      console.log("Usage: ogs mcp add [options] <name> <commandOrUrl> [args...]");
      console.log("");
      console.log("Examples:");
      console.log("  ogs mcp add --transport http figma https://mcp.figma.com/mcp");
      console.log("  ogs mcp add figma --env FIGMA_API_KEY=figd_xxx -- bunx figma-developer-mcp --stdio");
      return;
    }
    await runInteractive(["mcp", "add", "--scope", "user", ...mcpArgs], { timeoutMs: 60_000 });
  } else if (sub === "remove") {
    const name = args[2];
    if (!name) {
      console.log("Usage: ogs mcp remove <name>");
      return;
    }
    const settings = await readSettings();
    if (!settings.mcpServers?.[name]) {
      console.log(`MCP server "${name}" not found.`);
      return;
    }
    delete settings.mcpServers[name];
    await writeSettings(settings);
    console.log(`Removed MCP server: ${name}`);
  } else if (sub === "auth") {
    const name = args[2];
    if (!name) {
      console.log("Usage: ogs mcp auth <name>");
      return;
    }
    console.log(`Run the following to authenticate "${name}":\n`);
    console.log(`  HOME=${GEMINI_SANDBOX} ${GEMINI_BIN}`);
    console.log(`  /mcp auth ${name}\n`);
    console.log("A browser will open. After login, type /quit.");
  } else {
    console.log(`Unknown mcp subcommand: ${sub}`);
  }
}

async function readSettings(): Promise<SettingsFile> {
  try {
    const f = Bun.file(GEMINI_SETTINGS_PATH);
    if (await f.exists()) {
      const raw = await f.text();
      if (raw) return JSON.parse(raw) as SettingsFile;
    }
  } catch (_e) { /* ignore */ }
  return { security: { auth: { selectedType: "oauth-personal" } }, mcpServers: {} };
}

async function writeSettings(settings: SettingsFile): Promise<void> {
  await Bun.write(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

async function cmdDoctor(): Promise<void> {
  console.log("OGS Doctor");
  console.log("─────────");

  const checks: Array<{ ok: boolean }> = [];

  checks.push(await check("Bun binary", async () => {
    const p = process.execPath;
    if (!p) throw new Error("bun not found");
    return p;
  }));

  checks.push(await check("OGS root directory", async () => {
    if (!existsSync(OGS_ROOT)) throw new Error(`${OGS_ROOT} does not exist. Run: ogs install`);
    return OGS_ROOT;
  }));

  checks.push(await check("Gemini CLI binary", async () => {
    if (!(await isInstalled())) throw new Error(`${GEMINI_BIN} not found. Run: ogs install`);
    return GEMINI_BIN;
  }));

  checks.push(await check("Gemini CLI version", async () => {
    const current = await getInstalledVersion();
    const latest = await getLatestVersion();
    if (!current) throw new Error("Cannot determine installed version");
    if (latest && current !== latest) return `${current} (latest: ${latest} — run: ogs update)`;
    return `${current} (latest)`;
  }));

  checks.push(await check("Sandbox directory", async () => {
    if (!existsSync(GEMINI_SANDBOX)) throw new Error("Sandbox not initialized");
    return GEMINI_SANDBOX;
  }));

  checks.push(await check("Authentication", async () => {
    const s = await getStatus();
    if (!s.authenticated) throw new Error("Not authenticated. Run: ogs auth");
    return "authenticated";
  }));

  const passed = checks.filter((c) => c.ok).length;
  const total = checks.length;
  console.log(`\n${passed}/${total} checks passed.`);
  if (passed < total) process.exit(1);
}

async function check(name: string, fn: () => Promise<string>): Promise<{ ok: boolean }> {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}: ${detail}`);
    return { ok: true };
  } catch (err) {
    console.log(`  ✗ ${name}: ${(err as Error).message}`);
    return { ok: false };
  }
}

function cmdHelp(): void {
  console.log(`ogs — opencode-gemini-subagent CLI

Usage:
  ogs <command> [args...]

Commands:
  status      Show installation, auth, MCP, preset, and task status
  auth        Launch Gemini OAuth in the isolated sandbox
  auth:reset  Reset the sandbox and clear credentials
  install     Install @google/gemini-cli in ~/.ogs/
  update      Check for and install Gemini CLI updates
  tasks       List background tasks
  tasks clean Sweep old terminal tasks (72h+)
  mcp list    List MCP servers
  mcp add     Add an MCP server (passes args to gemini mcp add)
  mcp remove  Remove an MCP server: ogs mcp remove <name>
  mcp auth    Authenticate an MCP server: ogs mcp auth <name>
  doctor      Run diagnostic checks
  help        Show this help
`);
}

main().catch((err) => {
  console.error(`ogs: ${(err as Error)?.message ?? err}`);
  process.exit(1);
});
