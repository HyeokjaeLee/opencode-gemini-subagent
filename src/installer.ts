import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { OGS_ROOT, GEMINI_BIN, AGENTS_DIR } from "./paths.js";

const BUNDLED_AGENTS_DIR = path.join(import.meta.dir, "..", "agents");

const PACKAGE = "@google/gemini-cli";
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60_000;
const UPDATE_CHECK_FILE = `${OGS_ROOT}/.last-update-check`;

async function getLastUpdateCheck(): Promise<number> {
  try {
    const f = Bun.file(UPDATE_CHECK_FILE);
    if (await f.exists()) {
      return Number((await f.text()).trim());
    }
  } catch (_e) { /* ignore */ }
  return 0;
}

async function markUpdateCheck(): Promise<void> {
  try {
    await Bun.write(UPDATE_CHECK_FILE, String(Date.now()));
  } catch (_e) { /* ignore */ }
}

export async function getInstalledVersion(): Promise<string | null> {
  try {
    const pkgPath = `${OGS_ROOT}/node_modules/${PACKAGE}/package.json`;
    const f = Bun.file(pkgPath);
    if (!(await f.exists())) return null;
    const raw = await f.text();
    return JSON.parse(raw).version ?? null;
  } catch (_e) {
    return null;
  }
}

export async function getLatestVersion(): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(PACKAGE)}/latest`);
    if (!res.ok) return null;
    const data = await res.json() as { version?: string };
    return data.version ?? null;
  } catch (_e) {
    return null;
  }
}

export async function isInstalled(): Promise<boolean> {
  return Bun.file(GEMINI_BIN).exists();
}

async function ensureRoot(): Promise<void> {
  await mkdir(OGS_ROOT, { recursive: true });
  const pj = `${OGS_ROOT}/package.json`;
  if (!(await Bun.file(pj).exists())) {
    const minimal = JSON.stringify(
      {
        name: "ogs-gemini-env",
        private: true,
        description: "Isolated Gemini CLI environment for opencode-gemini-subagent",
      },
      null,
      2,
    );
    await Bun.write(pj, minimal);
  }
}

export async function install(opts: { silent?: boolean } = {}): Promise<string> {
  await ensureRoot();
  const silent = opts.silent ?? false;
  const stdio: "inherit" | "ignore" = silent ? "ignore" : "inherit";

  const result = Bun.spawnSync(
    ["bun", "add", "--cwd", OGS_ROOT, PACKAGE],
    {
      stdio: ["ignore", stdio, stdio],
      env: Bun.env,
      timeout: 120_000,
    },
  );

  if (!result.success) {
    throw new Error(`bun add failed with exit code ${result.exitCode}`);
  }

  if (!(await Bun.file(GEMINI_BIN).exists())) {
    throw new Error(
      `Installation completed but ${GEMINI_BIN} not found.`,
    );
  }

  return (await getInstalledVersion())!;
}

export async function syncBundledAgents(): Promise<{ copied: number }> {
  if (existsSync(AGENTS_DIR)) return { copied: 0 };
  if (!existsSync(BUNDLED_AGENTS_DIR)) return { copied: 0 };
  await mkdir(AGENTS_DIR, { recursive: true });
  let copied = 0;
  const glob = new Bun.Glob("*.md");
  for (const match of glob.scanSync({ cwd: BUNDLED_AGENTS_DIR })) {
    const src = Bun.file(path.join(BUNDLED_AGENTS_DIR, match));
    await Bun.write(path.join(AGENTS_DIR, match), src);
    copied++;
  }
  return { copied };
}

export async function updateIfNeeded(opts: { silent?: boolean } = {}): Promise<{ updated: boolean; from: string | null; to: string | null }> {
  const current = await getInstalledVersion();
  if (!current) {
    const version = await install(opts);
    return { updated: true, from: null, to: version };
  }

  if (Date.now() - (await getLastUpdateCheck()) < UPDATE_CHECK_TTL_MS) {
    return { updated: false, from: current, to: current };
  }

  const latest = await getLatestVersion();
  await markUpdateCheck();

  if (!latest || current === latest) {
    return { updated: false, from: current, to: latest ?? current };
  }

  const silent = opts.silent ?? false;
  const stdio: "inherit" | "ignore" = silent ? "ignore" : "inherit";
  const result = Bun.spawnSync(
    ["bun", "update", "--cwd", OGS_ROOT, PACKAGE],
    {
      stdio: ["ignore", stdio, stdio],
      env: Bun.env,
      timeout: 120_000,
    },
  );

  if (!result.success) {
    throw new Error(`bun update failed with exit code ${result.exitCode}`);
  }

  const after = await getInstalledVersion();
  return { updated: true, from: current, to: after ?? latest };
}

export async function ensureInstalled(opts: { silent?: boolean } = {}): Promise<{ bin: string; version: string | null }> {
  await syncBundledAgents();
  if (!(await isInstalled())) {
    const version = await install({ silent: opts.silent ?? true });
    return { bin: GEMINI_BIN, version };
  }

  updateIfNeeded({ silent: opts.silent ?? true }).catch(() => {});
  return { bin: GEMINI_BIN, version: await getInstalledVersion() };
}
