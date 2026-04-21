#!/usr/bin/env node
/**
 * postinstall: runs after npm install of opencode-gemini-subagent.
 * Prints a short setup guide. Does NOT auto-install Gemini CLI
 * (that would require interactive auth and might surprise the user).
 */

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

  4. Add to opencode.json:
     {
       "plugin": {
         "opencode-gemini-subagent": true
       }
     }

CLI reference: ogs help
`);
