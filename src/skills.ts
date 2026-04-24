import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "./paths.js";

const CACHE_TTL_MS = 5 * 60_000;
const MAX_SKILL_BYTES = 4_096;
const MAX_TOTAL_BYTES = 32_768;

export interface Skill {
  name: string;
  filePath: string;
  content: string;
  description: string;
}

let cachedSkills: Skill[] | null = null;
let cachedAt = 0;

function parseSimpleFrontmatter(raw: string): { description: string } {
  const desc = { description: "" };
  if (!raw.startsWith("---")) return desc;
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return desc;
  const yaml = raw.slice(3, end).trim();
  for (const line of yaml.split("\n")) {
    const m = line.match(/^description:\s*["']?(.+?)["']?\s*$/);
    if (m) {
      desc.description = m[1].trim();
      break;
    }
  }
  return desc;
}

function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8") + "\n... (truncated)";
}

export async function loadSkills(): Promise<Skill[]> {
  if (cachedSkills && Date.now() - cachedAt < CACHE_TTL_MS) return cachedSkills;
  if (!existsSync(SKILLS_DIR)) return [];

  let entries;
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  } catch (_e) {
    return [];
  }

  const skills: Skill[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const skillFile = path.join(SKILLS_DIR, ent.name, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    try {
      const content = await readFile(skillFile, "utf8");
      const fm = parseSimpleFrontmatter(content);
      skills.push({
        name: ent.name,
        filePath: skillFile,
        content,
        description: fm.description,
      });
    } catch (_e) { /* skip unreadable skills */ }
  }
  cachedSkills = skills;
  cachedAt = Date.now();
  return skills;
}

export async function formatSkillsContext(opts: { include?: string[] } = {}): Promise<string> {
  const skills = await loadSkills();
  const filtered = opts.include?.length
    ? skills.filter((s) => opts.include!.includes(s.name))
    : skills;

  if (filtered.length === 0) return "";

  let totalBytes = 0;
  const sections: string[] = [];
  for (const s of filtered) {
    const truncated = truncateToBytes(s.content.trim(), MAX_SKILL_BYTES);
    const section = `## Skill: ${s.name}\n\n${truncated}`;
    const sectionBytes = Buffer.byteLength(section, "utf8");
    if (totalBytes + sectionBytes > MAX_TOTAL_BYTES) break;
    totalBytes += sectionBytes;
    sections.push(section);
  }

  if (sections.length === 0) return "";

  return [
    "# Available OpenCode Skills (reference only — use when relevant)",
    "",
    ...sections,
  ].join("\n");
}

export async function listSkillNames(): Promise<string[]> {
  const skills = await loadSkills();
  return skills.map((s) => s.name);
}

export function invalidateCache(): void {
  cachedSkills = null;
  cachedAt = 0;
}
