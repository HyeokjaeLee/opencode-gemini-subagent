import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { OGS_ROOT, GEMINI_BIN, AGENTS_DIR } from "./paths.js";

const BUNDLED_AGENTS_DIR = path.join(import.meta.dir, "..", "agents");

const PACKAGE = "@google/gemini-cli";
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60_000;
const UPDATE_CHECK_FILE = `${OGS_ROOT}/.last-update-check`;

function getLastUpdateCheck(): number {
  try {
    if (existsSync(UPDATE_CHECK_FILE)) {
      return Number(readFileSync(UPDATE_CHECK_FILE, "utf8").trim());
    }
  } catch (_e) { /* ignore */ }
  return 0;
}

function markUpdateCheck(): void {
  try {
    mkdirSync(OGS_ROOT, { recursive: true });
    writeFileSync(UPDATE_CHECK_FILE, String(Date.now()), { mode: 0o644 });
  } catch (_e) { /* ignore */ }
}

export function getInstalledVersion(): string | null {
  try {
    const pkgPath = `${OGS_ROOT}/node_modules/${PACKAGE}/package.json`;
    if (!existsSync(pkgPath)) return null;
    const raw = readFileSync(pkgPath, "utf8");
    return JSON.parse(raw).version ?? null;
  } catch (_e) {
    return null;
  }
}

export function getLatestVersion(): string | null {
  try {
    const result = Bun.spawnSync(["npm", "view", PACKAGE, "version"], {
      cwd: OGS_ROOT,
      env: Bun.env,
    });
    if (!result.success || !result.stdout) return null;
    const out = new TextDecoder().decode(result.stdout).trim();
    return out || null;
  } catch (_e) {
    return null;
  }
}

export function isInstalled(): boolean {
  return existsSync(GEMINI_BIN);
}

function ensureRoot(): void {
  if (!existsSync(OGS_ROOT)) {
    mkdirSync(OGS_ROOT, { recursive: true });
  }
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
    writeFileSync(pj, minimal, "utf8");
  }
}

export function install(opts: { silent?: boolean } = {}): string {
  ensureRoot();
  const silent = opts.silent ?? false;
  const stdio: "inherit" | "ignore" = silent ? "ignore" : "inherit";

  const result = Bun.spawnSync(
    ["npm", "install", "--prefix", OGS_ROOT, PACKAGE],
    {
      stdio: ["ignore", stdio, stdio],
      env: Bun.env,
      timeout: 120_000,
    },
  );

  if (!result.success) {
    throw new Error(`npm install failed with exit code ${result.exitCode}`);
  }

  if (!existsSync(GEMINI_BIN)) {
    throw new Error(
      `Installation completed but ${GEMINI_BIN} not found.`,
    );
  }

  return getInstalledVersion()!;
}

export function syncBundledAgents(): { copied: number } {
  if (existsSync(AGENTS_DIR)) return { copied: 0 };
  if (!existsSync(BUNDLED_AGENTS_DIR)) return { copied: 0 };
  mkdirSync(AGENTS_DIR, { recursive: true });
  let copied = 0;
  const glob = new Bun.Glob("*.md");
  for (const match of glob.scanSync({ cwd: BUNDLED_AGENTS_DIR })) {
    copyFileSync(path.join(BUNDLED_AGENTS_DIR, match), path.join(AGENTS_DIR, match));
    copied++;
  }
  return { copied };
}

export function updateIfNeeded(opts: { silent?: boolean } = {}): { updated: boolean; from: string | null; to: string | null } {
  const current = getInstalledVersion();
  if (!current) {
    const version = install(opts);
    return { updated: true, from: null, to: version };
  }

  if (Date.now() - getLastUpdateCheck() < UPDATE_CHECK_TTL_MS) {
    return { updated: false, from: current, to: current };
  }

  const latest = getLatestVersion();
  markUpdateCheck();

  if (!latest || current === latest) {
    return { updated: false, from: current, to: latest ?? current };
  }

  const silent = opts.silent ?? false;
  const stdio: "inherit" | "ignore" = silent ? "ignore" : "inherit";
  const result = Bun.spawnSync(
    ["npm", "update", "--prefix", OGS_ROOT, PACKAGE],
    {
      stdio: ["ignore", stdio, stdio],
      env: Bun.env,
      timeout: 120_000,
    },
  );

  if (!result.success) {
    throw new Error(`npm update failed with exit code ${result.exitCode}`);
  }

  const after = getInstalledVersion();
  return { updated: true, from: current, to: after ?? latest };
}

export function ensureInstalled(opts: { silent?: boolean } = {}): { bin: string; version: string | null } {
  syncBundledAgents();
  if (!isInstalled()) {
    const version = install({ silent: opts.silent ?? true });
    return { bin: GEMINI_BIN, version };
  }

  try {
    const result = updateIfNeeded({ silent: opts.silent ?? true });
    return { bin: GEMINI_BIN, version: result.to };
  } catch (_e) {
    return { bin: GEMINI_BIN, version: getInstalledVersion() };
  }
}
