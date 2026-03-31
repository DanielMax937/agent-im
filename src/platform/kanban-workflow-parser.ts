/**
 * Parses a trailing `KANBAN_ACTION:NAME` marker from assistant output.
 * Optional lines after the action line are treated as payload (e.g. reject comment).
 */
export function parseKanbanAction(content: string): { action: string; payload?: string } | null {
  const idx = content.lastIndexOf('KANBAN_ACTION:');
  if (idx === -1) return null;
  const after = content.slice(idx + 'KANBAN_ACTION:'.length).trim();
  const nl = after.indexOf('\n');
  if (nl === -1) {
    const action = after.replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z_]+$/.test(action)) return null;
    return { action };
  }
  const action = after
    .slice(0, nl)
    .trim()
    .replace(/\s+/g, '_')
    .toUpperCase();
  if (!/^[A-Z_]+$/.test(action)) return null;
  const payload = after.slice(nl + 1).trim() || undefined;
  return { action, payload };
}
