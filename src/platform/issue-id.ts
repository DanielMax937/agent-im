import type { Project } from './types';

/**
 * Human-readable issue key prefix for auto-generated IDs (`PREFIX-1`, `PREFIX-2`).
 * Uses `issueIdPrefix` when set; otherwise the first segment of `project.id` (e.g. `demo-project` → `DEMO`).
 */
export function resolveIssueIdPrefix(project: Project): string {
  const raw = project.issueIdPrefix?.trim();
  if (raw) {
    const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (cleaned) return cleaned.slice(0, 24);
  }
  const first = project.id.split(/[-_]/)[0] ?? project.id;
  const cleaned = first.replace(/[^a-zA-Z0-9]/g, '') || 'P';
  return cleaned.toUpperCase().slice(0, 16);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Next issue id for a project: `{prefix}-{max+1}` scanning existing `PREFIX-n` keys in that project.
 */
export function allocateNextIssueId(
  projectId: string,
  prefix: string,
  listIssueIdsForProject: (projectId: string) => string[],
): string {
  const safe = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'P';
  const re = new RegExp(`^${escapeRegExp(safe)}-(\\d+)$`);
  let max = 0;
  for (const issueId of listIssueIdsForProject(projectId)) {
    const m = issueId.match(re);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${safe}-${max + 1}`;
}
