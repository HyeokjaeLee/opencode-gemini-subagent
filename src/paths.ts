import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const OGS_ROOT: string = (() => {
  const fromEnv = Bun.env.OGS_ROOT;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return path.join(homedir(), ".ogs");
})();

export const GEMINI_BIN = path.join(OGS_ROOT, "node_modules", ".bin", "gemini");

export const GEMINI_SANDBOX = path.join(OGS_ROOT, "sandbox");

export const GEMINI_HOME = path.join(GEMINI_SANDBOX, ".gemini");

export const NPM_CACHE_DIR = path.join(GEMINI_SANDBOX, ".npm-cache");

export const GEMINI_SETTINGS_PATH = path.join(GEMINI_HOME, "settings.json");
export const GEMINI_OAUTH_CREDS_PATH = path.join(GEMINI_HOME, "oauth_creds.json");

export const TASKS_DIR = path.join(OGS_ROOT, "tasks");

export const AGENTS_DIR: string = (() => {
  const fromEnv = Bun.env.OGS_AGENTS_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return path.join(homedir(), ".config", "opencode", "agents-gemini");
})();

export const SKILLS_DIR: string = (() => {
  const fromEnv = Bun.env.OGS_SKILLS_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return path.join(homedir(), ".config", "opencode", "skills");
})();

export const GEMINI_GLOBAL_HOME = path.join(homedir(), ".gemini");

export function assertNotGlobal(targetPath: string): void {
  const resolved = path.resolve(targetPath);
  const global = path.resolve(GEMINI_GLOBAL_HOME);
  if (resolved === global || resolved.startsWith(global + path.sep)) {
    throw new Error(
      `Refusing to operate on the global Gemini home (${global}). ` +
        `The bridge must stay isolated in ${GEMINI_SANDBOX}.`,
    );
  }
}
