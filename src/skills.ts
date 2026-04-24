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
  if (!(await Bun.file(SKILLS_DIR).stat().catch(() => null))) return [];

  const skills: Skill[] = [];
  const glob = new Bun.Glob("*/SKILL.md");

  try {
    for await (const match of glob.scan({ cwd: SKILLS_DIR })) {
      const dirName = match.split("/")[0]!;
      const skillFile = path.join(SKILLS_DIR, match);
      if (!(await Bun.file(skillFile).exists())) continue;
      try {
        const content = await Bun.file(skillFile).text();
        const fm = parseSimpleFrontmatter(content);
        skills.push({
          name: dirName,
          filePath: skillFile,
          content,
          description: fm.description,
        });
      } catch (_e) { /* skip unreadable skills */ }
    }
  } catch (_e) {
    return [];
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
