import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OGS_ROOT, GEMINI_BIN, AGENTS_DIR } from "./paths.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLED_AGENTS_DIR = path.join(__dirname, "..", "agents");

const PACKAGE = "@google/gemini-cli";
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60_000;
const UPDATE_CHECK_FILE = `${OGS_ROOT}/.last-update-check`;

function getLastUpdateCheck() {
  try {
    if (existsSync(UPDATE_CHECK_FILE)) {
      return Number(readFileSync(UPDATE_CHECK_FILE, "utf8").trim());
    }
  } catch {}
  return 0;
}

function markUpdateCheck() {
  try {
    mkdirSync(OGS_ROOT, { recursive: true });
    writeFileSync(UPDATE_CHECK_FILE, String(Date.now()), { mode: 0o644 });
  } catch {}
}

export function getInstalledVersion() {
  try {
    const pkgPath = `${OGS_ROOT}/node_modules/${PACKAGE}/package.json`;
    if (!existsSync(pkgPath)) return null;
    const raw = readFileSync(pkgPath, "utf8");
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

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

export function isInstalled() {
  return existsSync(GEMINI_BIN);
}

function ensureRoot() {
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
    execSync(`cat > "${pj}" << 'OGSEOF'\n${minimal}\nOGSEOF`, {
      stdio: "pipe",
    });
  }
}

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
      `Installation completed but ${GEMINI_BIN} not found.`,
    );
  }

  return getInstalledVersion();
}

export function syncBundledAgents() {
  if (!existsSync(BUNDLED_AGENTS_DIR)) return { copied: 0 };
  mkdirSync(AGENTS_DIR, { recursive: true });
  let copied = 0;
  for (const f of readdirSync(BUNDLED_AGENTS_DIR)) {
    if (!f.endsWith(".md")) continue;
    const src = path.join(BUNDLED_AGENTS_DIR, f);
    const dst = path.join(AGENTS_DIR, f);
    if (!existsSync(dst)) {
      copyFileSync(src, dst);
      copied++;
    }
  }
  return { copied };
}

export function updateIfNeeded(opts = {}) {
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
  const stdio = silent ? "pipe" : "inherit";
  execSync(`npm update --prefix "${OGS_ROOT}" ${PACKAGE}`, {
    stdio,
    timeout: 120_000,
  });

  const after = getInstalledVersion();
  return { updated: true, from: current, to: after ?? latest };
}

export function ensureInstalled(opts = {}) {
  syncBundledAgents();
  if (!isInstalled()) {
    const version = install({ silent: opts.silent ?? true });
    return { bin: GEMINI_BIN, version };
  }

  try {
    const result = updateIfNeeded({ silent: opts.silent ?? true });
    return { bin: GEMINI_BIN, version: result.to };
  } catch {
    return { bin: GEMINI_BIN, version: getInstalledVersion() };
  }
}
