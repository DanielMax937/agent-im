/**
 * Reference loader for research mode.
 *
 * Before the orchestrator loop starts, Agent A must read all files in
 * `<folder>/reference/` to build context. This module handles:
 *   - Recursive directory scanning
 *   - Manifest generation
 *   - Text packing with budget controls
 */

import fs from 'node:fs';
import path from 'node:path';

export const REFERENCE_DIR_NAME = 'reference';

/** Extensions considered safe to read as text and inject into prompts. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.csv', '.tsv',
  '.ts', '.js', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h',
  '.toml', '.ini', '.cfg', '.env', '.sh', '.bash', '.zsh',
  '.html', '.css', '.xml', '.sql', '.r', '.rb', '.lua',
  '.tex', '.bib', '.org', '.rst', '.adoc',
]);

export interface ReferenceFileEntry {
  /** Relative path from the reference directory root. */
  relativePath: string;
  /** Absolute path on disk. */
  absolutePath: string;
  /** File size in bytes. */
  size: number;
  /** Whether this file is text-readable (based on extension). */
  isText: boolean;
}

export interface ReferenceManifest {
  /** Absolute path to the reference directory. */
  referenceDir: string;
  /** All discovered files. */
  files: ReferenceFileEntry[];
  /** Total number of files. */
  totalFiles: number;
  /** Total size of text-readable files in bytes. */
  totalTextBytes: number;
  /** Files skipped (binary/unrecognized). */
  skippedFiles: string[];
  /** Timestamp of indexing. */
  indexedAt: string;
}

function isTextFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

function scanDirRecursive(dir: string, basePath: string): ReferenceFileEntry[] {
  const entries: ReferenceFileEntry[] = [];
  if (!fs.existsSync(dir)) return entries;

  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const item of items) {
    if (item.name.startsWith('.')) continue; // skip hidden
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      entries.push(...scanDirRecursive(fullPath, basePath));
    } else if (item.isFile()) {
      const stat = fs.statSync(fullPath);
      entries.push({
        relativePath: path.relative(basePath, fullPath),
        absolutePath: fullPath,
        size: stat.size,
        isText: isTextFile(fullPath),
      });
    }
  }
  return entries;
}

/**
 * Index all files in `<folder>/reference/`.
 * Returns null if the reference directory doesn't exist.
 */
export function indexReferences(folder: string): ReferenceManifest | null {
  const refDir = path.join(folder, REFERENCE_DIR_NAME);
  if (!fs.existsSync(refDir) || !fs.statSync(refDir).isDirectory()) {
    return null;
  }

  const files = scanDirRecursive(refDir, refDir);
  const textFiles = files.filter((f) => f.isText);
  const skippedFiles = files.filter((f) => !f.isText).map((f) => f.relativePath);

  return {
    referenceDir: refDir,
    files,
    totalFiles: files.length,
    totalTextBytes: textFiles.reduce((sum, f) => sum + f.size, 0),
    skippedFiles,
    indexedAt: new Date().toISOString(),
  };
}

/**
 * Build a text pack from the manifest, respecting a character budget.
 * Files are included in directory order; if the budget is exhausted,
 * remaining files are listed by name only.
 */
export function buildReferencePack(
  manifest: ReferenceManifest,
  maxChars: number = 50000,
): string {
  const textFiles = manifest.files.filter((f) => f.isText);
  if (textFiles.length === 0) {
    return '_(no text reference files found)_';
  }

  const sections: string[] = [];
  let usedChars = 0;
  const includedFiles: string[] = [];
  const truncatedFiles: string[] = [];

  for (const file of textFiles) {
    const header = `### ${file.relativePath}\n\n`;
    const headerLen = header.length;

    if (usedChars + headerLen + file.size > maxChars) {
      // Try to include at least a partial read
      const remainingBudget = maxChars - usedChars - headerLen - 100;
      if (remainingBudget > 500) {
        try {
          const content = fs.readFileSync(file.absolutePath, 'utf8');
          const truncated = content.slice(0, remainingBudget);
          sections.push(`${header}\`\`\`\n${truncated}\n…(truncated, ${file.size} bytes total)\n\`\`\`\n`);
          usedChars += header.length + truncated.length + 50;
          includedFiles.push(file.relativePath + ' (truncated)');
        } catch {
          truncatedFiles.push(file.relativePath);
        }
      } else {
        truncatedFiles.push(file.relativePath);
      }
      continue;
    }

    try {
      const content = fs.readFileSync(file.absolutePath, 'utf8');
      sections.push(`${header}\`\`\`\n${content}\n\`\`\`\n`);
      usedChars += headerLen + content.length + 10;
      includedFiles.push(file.relativePath);
    } catch {
      truncatedFiles.push(file.relativePath);
    }
  }

  if (truncatedFiles.length > 0) {
    sections.push(
      `\n### _(files not included due to budget)_\n\n` +
        truncatedFiles.map((f) => `- ${f}`).join('\n') +
        '\n',
    );
  }

  if (manifest.skippedFiles.length > 0) {
    sections.push(
      `\n### _(binary/non-text files — read with tools if needed)_\n\n` +
        manifest.skippedFiles.map((f) => `- ${f}`).join('\n') +
        '\n',
    );
  }

  return sections.join('\n');
}

/**
 * Write the reference manifest to the session directory.
 */
export function writeManifest(sessionDir: string, manifest: ReferenceManifest): void {
  fs.mkdirSync(sessionDir, { recursive: true });
  const manifestPath = path.join(sessionDir, 'reference-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
