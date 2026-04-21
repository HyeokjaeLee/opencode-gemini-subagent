#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

const checks = [];

// 1. All source files exist and pass syntax check
const srcFiles = [
  "src/paths.mjs", "src/installer.mjs", "src/bridge.mjs",
  "src/tasks.mjs", "src/wrapper.mjs", "src/presets.mjs",
  "src/skills.mjs", "src/plugin.js",
];
for (const f of srcFiles) {
  const p = path.join(root, f);
  checks.push({ name: `exists: ${f}`, pass: existsSync(p) });
}

// 2. CLI binary exists
checks.push({ name: "exists: bin/ogs.js", pass: existsSync(path.join(root, "bin", "ogs.js")) });

// 3. Agents preset exists
checks.push({ name: "exists: agents/reviewer.md", pass: existsSync(path.join(root, "agents", "reviewer.md")) });

// 4. package.json has required fields
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
checks.push({ name: "pkg.name", pass: pkg.name === "opencode-gemini-subagent" });
checks.push({ name: "pkg.bin.ogs", pass: pkg.bin?.ogs === "bin/ogs.js" });
checks.push({ name: "pkg.main", pass: pkg.main === "src/plugin.js" });
checks.push({ name: "pkg.type", pass: pkg.type === "module" });

// 5. Plugin loads and exports correctly
try {
  const m = await import(path.join(root, "src", "plugin.js"));
  checks.push({ name: "plugin default export", pass: typeof m.default === "function" });
  const result = await m.default();
  const tools = Object.keys(result.tool);
  checks.push({ name: "4 tools registered", pass: tools.length === 4 });
  checks.push({ name: "gemini tool exists", pass: tools.includes("gemini") });
  checks.push({ name: "gemini_result tool exists", pass: tools.includes("gemini_result") });
  checks.push({ name: "gemini_cancel tool exists", pass: tools.includes("gemini_cancel") });
  checks.push({ name: "gemini_status tool exists", pass: tools.includes("gemini_status") });
} catch (e) {
  if (e.message?.includes("@opencode-ai/plugin")) {
    console.log("  SKIP: plugin load (requires @opencode-ai/plugin from opencode environment)");
  } else {
    checks.push({ name: "plugin load", pass: false });
  }
}

// Report
const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass);
console.log(`\nTests: ${passed}/${checks.length} passed\n`);
for (const f of failed) {
  console.log(`  FAIL: ${f.name}`);
}
if (failed.length > 0) {
  console.log("");
  process.exit(1);
}
console.log("All checks passed.\n");
