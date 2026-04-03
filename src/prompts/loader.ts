/**
 * Prompt template loader.
 *
 * Templates live in src/prompts/{system,bridge,kanban}/*.md
 * Variable placeholders use {{varName}} syntax.
 * All templates are loaded synchronously via fs.readFileSync and cached in memory.
 */

import fs from 'fs';
import path from 'path';

const cache = new Map<string, string>();

export function loadTemplate(name: string): string {
  if (cache.has(name)) return cache.get(name)!;
  const filePath = path.join(process.cwd(), 'src', 'prompts', `${name}.md`);
  const content = fs.readFileSync(filePath, 'utf-8');
  cache.set(name, content);
  return content;
}

export function renderPrompt(name: string, vars?: Record<string, string>): string {
  let template = loadTemplate(name);
  if (vars) {
    for (const [key, value] of Object.entries(vars)) {
      template = template.replaceAll(`{{${key}}}`, value);
    }
  }
  return template;
}

/** Clear cache (useful in tests) */
export function clearPromptCache(): void {
  cache.clear();
}
