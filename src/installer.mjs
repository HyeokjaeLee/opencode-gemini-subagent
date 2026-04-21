/**
 * Gemini CLI installer for the isolated OGS_ROOT environment.
 *
 * Strategy: install @google/gemini-cli directly via `npm install` in OGS_ROOT.
 * No npx — direct binary for speed. Auto-updates on version mismatch.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { OGS_ROOT, GEMINI_BIN } from "./paths.mjs";

const PACKAGE = "@google/gemini-cli";

/**
 * Get the locally installed version of @google/gemini-cli, or null.
 */
export function getInstalledVersion() {
  try {
    const pkgPath = `${OGS_ROOT}/node_modules/${PACKAGE}/package.json`;
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(
      execSync(`cat "${pkgPath}"`, { encoding: "utf8" }),
    );
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the latest version available on npm registry, or null on failure.
 */
export function getLatestVersion() {
  try {
    const out = execSync(`npm view ${PACKAGE} version`, {
      encoding: "utf8",
      timeout: 15_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Check if the Gemini CLI binary exists at the expected path.
 */
export function isInstalled() {
  return existsSync(GEMINI_BIN);
}

/**
 * Ensure OGS_ROOT directory exists.
 */
function ensureRoot() {
  if (!existsSync(OGS_ROOT)) {
    mkdirSync(OGS_ROOT, { recursive: true });
  }
  // Ensure a minimal package.json so npm doesn't walk up
  const pj = `${OGS_ROOT}/package.json`;
  if (!existsSync(pj)) {
    const minimal = JSON.stringify(
      {
        name: "ogs-gemini-env",
        private: true,
        description: "Isolated Gemini CLI environment for opencode-gemini-subagent",
      },
      null,
      2,
    );
    execSync(`cat > "${pj}" << 'OGSEOF'\n${minimal}\nOGSEOF`, {
      stdio: "pipe",
    });
  }
}

/**
 * Install @google/gemini-cli in OGS_ROOT. Returns the installed version.
 *
 * @param {{ silent?: boolean }} opts
 */
export function install(opts = {}) {
  ensureRoot();
  const silent = opts.silent ?? false;
  const stdio = silent ? "pipe" : "inherit";

  execSync(`npm install --prefix "${OGS_ROOT}" ${PACKAGE}`, {
    stdio,
    timeout: 120_000,
  });

  if (!existsSync(GEMINI_BIN)) {
    throw new Error(
      `Installation completed but ${GEMINI_BIN} not found. ` +
        `Check npm output above for errors.`,
    );
  }

  return getInstalledVersion();
}

/**
 * Update @google/gemini-cli to latest if a newer version exists.
 * Returns { updated: boolean, from?: string, to?: string }.
 *
 * @param {{ silent?: boolean }} opts
 */
export function updateIfNeeded(opts = {}) {
  const current = getInstalledVersion();
  if (!current) {
    // Not installed — fresh install
    const version = install(opts);
    return { updated: true, from: null, to: version };
  }

  const latest = getLatestVersion();
  if (!latest) {
    // Can't reach registry — skip silently
    return { updated: false, from: current, to: current };
  }

  if (current === latest) {
    return { updated: false, from: current, to: latest };
  }

  // Newer version available — update
  const silent = opts.silent ?? false;
  const stdio = silent ? "pipe" : "inherit";
  execSync(`npm update --prefix "${OGS_ROOT}" ${PACKAGE}`, {
    stdio,
    timeout: 120_000,
  });

  const after = getInstalledVersion();
  return { updated: true, from: current, to: after ?? latest };
}

/**
 * Ensure Gemini CLI is installed and up-to-date. Called automatically
 * before each Gemini invocation. Silent by default — only logs on errors.
 *
 * @param {{ silent?: boolean }} opts
 * @returns {{ bin: string, version: string|null }}
 */
export function ensureInstalled(opts = {}) {
  if (!isInstalled()) {
    const version = install({ silent: opts.silent ?? true });
    return { bin: GEMINI_BIN, version };
  }

  // Check for updates (non-blocking best-effort)
  try {
    const result = updateIfNeeded({ silent: opts.silent ?? true });
    return { bin: GEMINI_BIN, version: result.to };
  } catch {
    // Update failed — use existing install
    return { bin: GEMINI_BIN, version: getInstalledVersion() };
  }
}
