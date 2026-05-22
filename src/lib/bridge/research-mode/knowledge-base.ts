/**
 * Knowledge base loader for research mode.
 *
 * Reads compiled entries from an Obsidian-vault-creator style knowledge vault.
 * The vault structure is:
 *   00_Raw/        — raw source documents
 *   01_Wiki/       — compiled wiki entries (our primary source)
 *   02_Interactions/ — interaction logs
 *   99_Scripts/    — automation scripts
 *
 * We read `01_Wiki/` entries and optionally filter by keywords from the goal.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface KnowledgeEntry {
  /** Relative path within 01_Wiki/. */
  relativePath: string;
  /** Full file content. */
  content: string;
  /** File size in bytes. */
  size: number;
}

const WIKI_DIR = '01_Wiki';

/**
 * Load knowledge entries from the vault's `01_Wiki/` directory.
 *
 * @param vaultPath - Absolute path to the knowledge vault root.
 * @param keywords - Optional keywords to filter entries (checks filename + content).
 * @param maxChars - Character budget for the returned text block.
 */
export function loadKnowledgeEntries(
  vaultPath: string,
  keywords?: string[],
  maxChars: number = 15000,
): string {
  const wikiDir = path.join(vaultPath, WIKI_DIR);
  if (!fs.existsSync(wikiDir) || !fs.statSync(wikiDir).isDirectory()) {
    return '';
  }

  const entries = scanWikiDir(wikiDir, wikiDir);
  if (entries.length === 0) return '';

  // Filter by keywords if provided
  let filtered = entries;
  if (keywords && keywords.length > 0) {
    const lowerKeywords = keywords.map((k) => k.toLowerCase());
    filtered = entries.filter((entry) => {
      const searchText = (entry.relativePath + ' ' + entry.content).toLowerCase();
      return lowerKeywords.some((kw) => searchText.includes(kw));
    });
    // Fall back to all entries if no keyword matches
    if (filtered.length === 0) filtered = entries;
  }

  // Sort by relevance (keyword match count) if keywords provided
  if (keywords && keywords.length > 0) {
    const lowerKeywords = keywords.map((k) => k.toLowerCase());
    filtered.sort((a, b) => {
      const scoreA = lowerKeywords.reduce(
        (s, kw) => s + (a.content.toLowerCase().includes(kw) ? 1 : 0),
        0,
      );
      const scoreB = lowerKeywords.reduce(
        (s, kw) => s + (b.content.toLowerCase().includes(kw) ? 1 : 0),
        0,
      );
      return scoreB - scoreA;
    });
  }

  // Build text block within budget
  const sections: string[] = [];
  let usedChars = 0;

  for (const entry of filtered) {
    const header = `#### ${entry.relativePath}\n\n`;
    const block = `${header}${entry.content}\n\n---\n\n`;
    if (usedChars + block.length > maxChars) {
      // Include truncated if room
      const remaining = maxChars - usedChars - header.length - 50;
      if (remaining > 200) {
        sections.push(`${header}${entry.content.slice(0, remaining)}…\n\n---\n\n`);
      }
      break;
    }
    sections.push(block);
    usedChars += block.length;
  }

  return sections.join('');
}

/**
 * Extract keywords from goal text for knowledge base filtering.
 * Simple heuristic: extract capitalized phrases, technical terms, etc.
 */
export function extractGoalKeywords(goalText: string): string[] {
  const keywords: string[] = [];

  // Extract words that appear important (capitalized, technical, multi-word phrases in quotes)
  const quotedPhrases = goalText.match(/"[^"]+"|'[^']+'/g) || [];
  for (const phrase of quotedPhrases) {
    keywords.push(phrase.replace(/['"]/g, '').trim());
  }

  // Extract markdown headings
  const headings = goalText.match(/^#+\s+(.+)$/gm) || [];
  for (const h of headings) {
    keywords.push(h.replace(/^#+\s+/, '').trim());
  }

  // Extract technical terms (CamelCase, UPPER_CASE, words with special chars)
  const technicalTerms = goalText.match(/\b[A-Z][a-zA-Z]{2,}\b|\b[A-Z_]{3,}\b/g) || [];
  keywords.push(...technicalTerms);

  // Deduplicate and limit
  return [...new Set(keywords)].slice(0, 20);
}

function scanWikiDir(dir: string, basePath: string): KnowledgeEntry[] {
  const entries: KnowledgeEntry[] = [];
  if (!fs.existsSync(dir)) return entries;

  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.name.startsWith('.') || item.name.startsWith('_')) continue;
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...scanWikiDir(fullPath, basePath));
    } else if (item.isFile() && item.name.endsWith('.md')) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        entries.push({
          relativePath: path.relative(basePath, fullPath),
          content,
          size: content.length,
        });
      } catch {
        // skip unreadable files
      }
    }
  }
  return entries;
}

/**
 * Check if a knowledge vault path is valid and contains wiki entries.
 */
export function isValidKnowledgeVault(vaultPath: string): boolean {
  if (!vaultPath || !fs.existsSync(vaultPath)) return false;
  const wikiDir = path.join(vaultPath, WIKI_DIR);
  return fs.existsSync(wikiDir) && fs.statSync(wikiDir).isDirectory();
}
