#!/usr/bin/env node
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pluginPath = resolve(__dirname, "src", "plugin.js");

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
