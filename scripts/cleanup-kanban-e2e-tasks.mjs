#!/usr/bin/env node
/**
 * Deletes Kanban tasks created by testcase automation (kanban-full-test-runner, kanban-test-flows).
 * Matches task.projectId starting with `e2e-` (see scripts/kanban-full-test-runner.mjs, kanban-test-flows.mjs).
 *
 * Env:
 *   AGENT_IM_BASE_URL  default http://127.0.0.1:3300
 *   DRY_RUN=1          only list matching tasks, no DELETE
 */
import { fetchJson } from './kanban-test-lib.mjs';

const IM = process.env.AGENT_IM_BASE_URL || 'http://127.0.0.1:3300';
const dry = process.env.DRY_RUN === '1' || process.env.DRY_RUN === 'true';

/** All automated Kanban E2E projects use this prefix. */
const E2E_PROJECT_RE = /^e2e-/;

async function main() {
  const list = await fetchJson(IM, '/api/tasks');
  if (!list.ok || !Array.isArray(list.data)) {
    console.error('GET /api/tasks failed:', list.status, list.text?.slice(0, 500));
    process.exit(1);
  }

  const tasks = list.data.filter((t) => t?.projectId && E2E_PROJECT_RE.test(String(t.projectId)));
  if (tasks.length === 0) {
    console.log('No tasks in e2e-* test projects.');
    return;
  }

  console.log(`Found ${tasks.length} task(s) (${dry ? 'dry-run' : 'deleting'}).`);

  let ok = 0;
  let fail = 0;
  for (const t of tasks) {
    const id = t.id;
    const pid = t.projectId;
    const issue = t.issueId ?? '';
    if (dry) {
      console.log(`  [dry-run] ${id} project=${pid} issue=${issue}`);
      ok += 1;
      continue;
    }
    const del = await fetchJson(IM, `/api/workflows/tasks/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (del.ok) {
      console.log(`  deleted ${id} project=${pid} issue=${issue}`);
      ok += 1;
    } else {
      console.error(`  FAILED ${id}:`, del.status, del.text?.slice(0, 300));
      fail += 1;
    }
  }

  console.log(`Done: ${ok} ok, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
