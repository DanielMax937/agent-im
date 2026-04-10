#!/usr/bin/env node
/**
 * Runs only docs/KANBAN-TESTCASES.md §3 开发 in_progress (A1,A3–A5；A2 为 Board 手工).
 * A1,A3: runA1A2A3; A4: runA4Escalation; A5: runA5RunnerStopped.
 */
import { execFileSync } from 'node:child_process';
import {
  ghCreateAndPush,
  projectBody,
  fetchJson,
  ensureOutDir,
  postProject,
  getFirstRunnerId,
  applyKanbanRunners,
  pollTaskState,
  writeCase,
} from './kanban-test-lib.mjs';
import { runA1A2A3, runA4Escalation, runA5RunnerStopped } from './kanban-test-flows.mjs';

const IM = process.env.AGENT_IM_BASE_URL || 'http://127.0.0.1:3300';
const CDS = process.env.CDS_BASE_URL || 'http://127.0.0.1:9223';
const RUN = `a-only-${Date.now()}`;
const OUT = ensureOutDir(RUN);
const tally = { pass: 0, fail: 0 };

function ok(id, pass, body) {
  writeCase(OUT, id, pass, body);
  if (pass) tally.pass += 1;
  else tally.fail += 1;
}

async function main() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  } catch {
    console.error('gh auth status failed. Run: gh auth login');
    process.exit(1);
  }

  const runnerId = await getFirstRunnerId(IM);
  if (!runnerId) {
    console.error('No platform runner: configure CTI_RUNNERS / GET /api/platform/runners');
    process.exit(1);
  }

  const ctx = {
    IM,
    RUN,
    runnerId,
    ok,
    ghCreateAndPush,
    projectBody,
    postProject,
    applyKanbanRunners,
    fetchJson,
    pollTaskState,
    CDS,
    cdsPost: async () => ({ ok: false, text: 'unused' }),
  };

  await runA1A2A3(ctx);
  await runA4Escalation(ctx);
  await runA5RunnerStopped(ctx);

  console.log(`Done. PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
  process.exit(tally.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
