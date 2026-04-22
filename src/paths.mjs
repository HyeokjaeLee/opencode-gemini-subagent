/**
 * Isolation contract (do not weaken without review):
 * - Bridge ONLY reads/writes inside OGS_ROOT.
 * - Bridge NEVER reads/writes ~/.gemini (the pre-existing global install).
 *
 * Isolation works by overriding HOME (Gemini CLI has no GEMINI_CONFIG_DIR env;
 * it hardcodes $HOME/.gemini/ for settings, creds, MCP, history). So the real
 * Gemini state directory inside the sandbox is <sandbox>/.gemini/.
 *
 * Gemini CLI is installed directly in OGS_ROOT via "npm install @google/gemini-cli"
 * for speed (no npx). Auto-updated on version mismatch.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const OGS_ROOT = (() => {
  const fromEnv = process.env.OGS_ROOT;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return path.join(homedir(), ".ogs");
})();

/** Gemini CLI binary — installed directly in OGS_ROOT/node_modules */
export const GEMINI_BIN = path.join(OGS_ROOT, "node_modules", ".bin", "gemini");

export const GEMINI_SANDBOX = path.join(OGS_ROOT, "sandbox");

export const GEMINI_HOME = path.join(GEMINI_SANDBOX, ".gemini");

export const NPM_CACHE_DIR = path.join(GEMINI_SANDBOX, ".npm-cache");

export const GEMINI_SETTINGS_PATH = path.join(GEMINI_HOME, "settings.json");
export const GEMINI_OAUTH_CREDS_PATH = path.join(GEMINI_HOME, "oauth_creds.json");

export const TASKS_DIR = path.join(OGS_ROOT, "tasks");

export const AGENTS_DIR = (() => {
  const fromEnv = process.env.OGS_AGENTS_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return path.join(homedir(), ".config", "opencode", "agents-gemini");
})();

export const SKILLS_DIR = (() => {
  const fromEnv = process.env.OGS_SKILLS_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return path.join(homedir(), ".config", "opencode", "skills");
})();

export const GEMINI_GLOBAL_HOME = path.join(homedir(), ".gemini");

export function assertNotGlobal(targetPath) {
  const resolved = path.resolve(targetPath);
  const global = path.resolve(GEMINI_GLOBAL_HOME);
  if (resolved === global || resolved.startsWith(global + path.sep)) {
    throw new Error(
      `Refusing to operate on the global Gemini home (${global}). ` +
        `The bridge must stay isolated in ${GEMINI_SANDBOX}.`,
    );
  }
}
