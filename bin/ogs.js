#!/usr/bin/env node
import { getStatus, runInteractive, resetSandbox, ensureSandbox, buildSandboxedEnv } from "../src/bridge.mjs";
import { install, updateIfNeeded, isInstalled, getInstalledVersion, getLatestVersion } from "../src/installer.mjs";
import { listTasks, inspectTask, cancelTask, readResult } from "../src/tasks.mjs";
import { loadPresets } from "../src/presets.mjs";
import { GEMINI_BIN, OGS_ROOT, GEMINI_SANDBOX, GEMINI_SETTINGS_PATH } from "../src/paths.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const cmd = args[0] ?? "help";

async function main() {
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

async function cmdStatus() {
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
  console.log(`  npm version:   ${s.npmPackageVersion ?? "(not installed)"}`);
  console.log(`  authenticated: ${s.authenticated ? "✓" : "✗"}`);
  console.log(`  mcp servers:   ${s.mcpServers.length > 0 ? s.mcpServers.join(", ") : "(none)"}`);
  console.log(`  presets:       ${presets.length} loaded`);
  if (errors.length > 0) {
    for (const e of errors) console.log(`    ⚠ ${e.file}: ${e.message}`);
  }
  console.log(`  tasks:         ${tasks.length} (${tasks.filter((t) => t.status === "running").length} running)`);
  console.log(`  global ignored:${s.globalHomeIgnored}`);
}

async function cmdAuth() {
  console.log("Launching Gemini OAuth in isolated sandbox...");
  await ensureSandbox();
  const res = await runInteractive(["auth"], { timeoutMs: 10 * 60_000 });
  process.exit(res.exitCode);
}

async function cmdAuthReset() {
  console.log("Resetting sandbox...");
  await resetSandbox();
  console.log("Sandbox reset. Run `ogs auth` to re-authenticate.");
}

async function cmdInstall() {
  console.log("Installing @google/gemini-cli in", OGS_ROOT);
  const version = install({ silent: false });
  console.log(`Installed: ${version}`);
}

async function cmdUpdate() {
  console.log("Checking for updates...");
  const result = updateIfNeeded({ silent: false });
  if (result.updated) {
    console.log(`Updated: ${result.from ?? "(new)"} → ${result.to}`);
  } else {
    console.log(`Already up-to-date: ${result.to}`);
  }
}

async function cmdTasks() {
  const sub = args[1];
  const tasks = await listTasks();

  if (sub === "clean" || sub === "sweep") {
    const { sweepOldTasks } = await import("../src/tasks.mjs");
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

async function cmdMcp() {
  const sub = args[1];
  if (!sub) {
    console.log("Usage: ogs mcp <list|add|remove|auth> [args...]");
    return;
  }

  if (sub === "list") {
    const settings = readSettings();
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
      console.log("  ogs mcp add figma --env FIGMA_API_KEY=figd_xxx -- npx -y figma-developer-mcp --stdio");
      return;
    }
    await runInteractive(["mcp", "add", "--scope", "user", ...mcpArgs], { timeoutMs: 60_000 });
  } else if (sub === "remove") {
    const name = args[2];
    if (!name) {
      console.log("Usage: ogs mcp remove <name>");
      return;
    }
    const settings = readSettings();
    if (!settings.mcpServers?.[name]) {
      console.log(`MCP server "${name}" not found.`);
      return;
    }
    delete settings.mcpServers[name];
    writeSettings(settings);
    console.log(`Removed MCP server: ${name}`);
  } else if (sub === "auth") {
    const name = args[2];
    if (!name) {
      console.log("Usage: ogs mcp auth <name>");
      return;
    }
    const { spawn } = await import("node:child_process");
    await ensureSandbox();

    console.log(`Authenticating MCP server "${name}"...`);
    console.log("A browser window will open for OAuth login.\n");

    const env = buildSandboxedEnv();

    if (process.platform === "darwin") {
      const pty = spawn("script", ["-q", "/dev/null", GEMINI_BIN], {
        cwd: process.cwd(),
        env,
        stdio: ["pipe", "inherit", "inherit"],
      });

      await new Promise((r) => setTimeout(r, 3000));
      pty.stdin.write(`/mcp auth ${name}\n`);

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.pipe(pty.stdin);
        process.stdin.resume();
      }

      const exitCode = await new Promise((resolve) => {
        pty.on("exit", (code) => resolve(code ?? 0));
      });

      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
        process.stdin.pause();
      }
      process.exit(exitCode);
    } else {
      await runInteractive([], { timeoutMs: 5 * 60_000 });
    }
  } else {
    console.log(`Unknown mcp subcommand: ${sub}`);
  }
}

function readSettings() {
  try {
    if (existsSync(GEMINI_SETTINGS_PATH)) {
      return JSON.parse(readFileSync(GEMINI_SETTINGS_PATH, "utf8"));
    }
  } catch {}
  return { security: { auth: { selectedType: "oauth-personal" } }, mcpServers: {} };
}

function writeSettings(settings) {
  if (!existsSync(GEMINI_SETTINGS_PATH)) {
    mkdirSync(path.dirname(GEMINI_SETTINGS_PATH), { recursive: true });
  }
  writeFileSync(GEMINI_SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

async function cmdDoctor() {
  console.log("OGS Doctor");
  console.log("─────────");

  const checks = [];

  checks.push(await check("Node binary", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("which", ["node"], { encoding: "utf8" });
    const p = r.stdout?.trim();
    if (!p) throw new Error("node not found in PATH");
    return p;
  }));

  checks.push(await check("OGS root directory", async () => {
    const { existsSync } = await import("node:fs");
    if (!existsSync(OGS_ROOT)) throw new Error(`${OGS_ROOT} does not exist. Run: ogs install`);
    return OGS_ROOT;
  }));

  checks.push(await check("Gemini CLI binary", async () => {
    if (!isInstalled()) throw new Error(`${GEMINI_BIN} not found. Run: ogs install`);
    return GEMINI_BIN;
  }));

  checks.push(await check("Gemini CLI version", async () => {
    const current = getInstalledVersion();
    const latest = getLatestVersion();
    if (!current) throw new Error("Cannot determine installed version");
    if (latest && current !== latest) return `${current} (latest: ${latest} — run: ogs update)`;
    return `${current} (latest)`;
  }));

  checks.push(await check("Sandbox directory", async () => {
    const { existsSync } = await import("node:fs");
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

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}: ${detail}`);
    return { ok: true };
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    return { ok: false };
  }
}

function cmdHelp() {
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
  console.error(`ogs: ${err?.message ?? err}`);
  process.exit(1);
});
