#!/usr/bin/env bun
import { resolve } from "node:path";

const pluginPath = resolve(import.meta.dir, "plugin.js");

try {
  const { syncBundledAgents } = await import("./installer.js");
  const { copied } = syncBundledAgents();
  if (copied > 0) {
    console.log(`[ogs] seeded ${copied} bundled agent(s) to agents-gemini/`);
  }
} catch (err: unknown) {
  const errorMessage = err instanceof Error ? err.message : String(err);
  console.warn(`[ogs] could not seed bundled agents: ${errorMessage}`);
}

console.log(`
╭─────────────────────────────────────────────╮
│  opencode-gemini-subagent (ogs) installed!  │
╰─────────────────────────────────────────────╯

First-time setup:

  1. Install Gemini CLI in the isolated environment:
     $ ogs install

  2. Authenticate (OAuth, saved only in ~/.ogs/sandbox):
     $ ogs auth

  3. Verify everything works:
     $ ogs doctor

  4. Add to your opencode.json (use the path below):
     {
       "plugin": ["${pluginPath}"]
     }

CLI reference: ogs help
`);
