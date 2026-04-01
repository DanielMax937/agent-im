import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Discovered installable skill (folder with SKILL.md under a well-known root). */
export interface SkillCatalogEntry {
  /** Stable id, e.g. `cursor/vercel-react-best-practices` */
  id: string;
  /** Source bucket: cursor | codex | claude | agent */
  source: string;
  /** Display label from SKILL.md frontmatter or title. */
  label: string;
  absolutePath: string;
}

const SKILL_ROOTS: { source: string; segments: string[] }[] = [
  { source: 'cursor', segments: ['.cursor', 'skills'] },
  { source: 'codex', segments: ['.codex', 'skills'] },
  { source: 'claude', segments: ['.claude', 'skills'] },
  { source: 'agent', segments: ['.agent', 'skills'] },
];

/** Alternate layout: `~/.agents/skills` (scan as source `agents`). */
const SKILL_ROOT_ALT: { source: string; segments: string[] } = {
  source: 'agents',
  segments: ['.agents', 'skills'],
};

let catalogCache: { entries: SkillCatalogEntry[]; at: number } | null = null;
const CACHE_MS = 60_000;

function readSkillLabel(skillMdPath: string, fallbackName: string): string {
  try {
    const raw = fs.readFileSync(skillMdPath, 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const nameLine = fm[1].match(/^\s*name:\s*(.+)$/m);
      if (nameLine) return nameLine[1].trim().replace(/^["']|["']$/g, '');
    }
    const h = raw.match(/^#\s+(.+)$/m);
    if (h) return h[1].trim();
  } catch {
    /* ignore */
  }
  return fallbackName;
}

function scanRoots(roots: { source: string; segments: string[] }[], baseDir: string): SkillCatalogEntry[] {
  const out: SkillCatalogEntry[] = [];
  for (const { source, segments } of roots) {
    const full = path.join(baseDir, ...segments);
    if (!fs.existsSync(full)) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of names) {
      if (!d.isDirectory()) continue;
      const skillMd = path.join(full, d.name, 'SKILL.md');
      if (!fs.existsSync(skillMd)) continue;
      const label = readSkillLabel(skillMd, d.name);
      out.push({
        id: `${source}/${d.name}`,
        source,
        label,
        absolutePath: skillMd,
      });
    }
  }
  return out;
}

/**
 * Lists skills from `~/.cursor/skills`, `~/.codex/skills`, `~/.claude/skills`, `~/.agent/skills`,
 * plus `~/.agents/skills`, and the same relative paths under `process.cwd()`.
 * Deduplicate by `id` (first occurrence wins). Cached ~60s.
 */
export function listSkillCatalogEntries(): SkillCatalogEntry[] {
  const now = Date.now();
  if (catalogCache && now - catalogCache.at < CACHE_MS) {
    return catalogCache.entries;
  }

  const roots = [...SKILL_ROOTS, SKILL_ROOT_ALT];
  const seen = new Set<string>();
  const merged: SkillCatalogEntry[] = [];

  const bases = [os.homedir(), process.cwd()].filter((b, i, a) => a.indexOf(b) === i);
  for (const base of bases) {
    for (const entry of scanRoots(roots, base)) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      merged.push(entry);
    }
  }

  merged.sort((a, b) => a.id.localeCompare(b.id));
  catalogCache = { entries: merged, at: now };
  return merged;
}

export function clearSkillCatalogCacheForTests(): void {
  catalogCache = null;
}

/** Map a catalog id to a prompt line; unknown ids pass through. */
export function resolveSkillIdToPromptLine(skillId: string): string {
  const entry = listSkillCatalogEntries().find((e) => e.id === skillId);
  if (entry) return entry.label;
  return skillId;
}
