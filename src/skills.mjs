/**
 * Skill loader for opencode skills.
 *
 * Reads SKILL.md files from the opencode skills directory and provides
 * them as formatted context for Gemini prompts.
 */

import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { SKILLS_DIR } from "./paths.mjs";

/**
 * @typedef {Object} SkillInfo
 * @property {string} name       Directory name (e.g. "typescript")
 * @property {string} filePath   Absolute path to SKILL.md
 * @property {string} content    Full markdown content
 * @property {string} [description]  Extracted from YAML frontmatter if present
 */

/**
 * Parse a simple YAML frontmatter to extract the description field.
 * Minimal parser — only handles flat key: value pairs.
 */
function parseSimpleFrontmatter(raw) {
  const desc = {
    description: "",
  };
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

/**
 * Load all available skills. Returns array of SkillInfo objects.
 * Invalid or unreadable skills are silently skipped.
 *
 * @returns {Promise<SkillInfo[]>}
 */
export async function loadSkills() {
  if (!existsSync(SKILLS_DIR)) return [];

  let entries;
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills = [];
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
    } catch {
      // Skip unreadable skills
    }
  }
  return skills;
}

/**
 * Format skills as a context block suitable for injection into a Gemini prompt.
 * Only includes skills matching the given names (or all if no filter).
 *
 * @param {{ include?: string[] }} [opts]
 * @returns {Promise<string>}
 */
export async function formatSkillsContext(opts = {}) {
  const skills = await loadSkills();
  const filtered = opts.include?.length
    ? skills.filter((s) => opts.include.includes(s.name))
    : skills;

  if (filtered.length === 0) return "";

  const sections = filtered.map((s) => {
    const header = `## Skill: ${s.name}`;
    return `${header}\n\n${s.content.trim()}`;
  });

  return [
    "# Available OpenCode Skills",
    "",
    "The following skills are available as reference. Use them to guide your work:",
    "",
    ...sections,
  ].join("\n");
}

/**
 * Get a list of available skill names for tool descriptions.
 *
 * @returns {Promise<string[]>}
 */
export async function listSkillNames() {
  const skills = await loadSkills();
  return skills.map((s) => s.name);
}
