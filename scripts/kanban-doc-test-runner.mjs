#!/usr/bin/env node
/**
 * Runs API-level checks from docs/KANBAN-TESTCASES.md against a live agent-im server.
 * For each case: creates a fresh GitHub repo under bitstripecn (when a project/repo is needed),
 * registers a Project, then runs HTTP assertions. Results are written to docs/test-results/<ID>.md
 *
 * Usage: AGENT_IM_BASE_URL=http://127.0.0.1:3000 node scripts/kanban-doc-test-runner.mjs
 */
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';

const BASE = process.env.AGENT_IM_BASE_URL || 'http://127.0.0.1:3000';
const ORG = process.env.KANBAN_E2E_ORG || 'bitstripecn';
const RUN = `run-${Date.now()}`;
const OUT = 'docs/test-results';

mkdirSync(OUT, { recursive: true });

function writeCase(id, pass, body) {
  const status = pass ? 'PASS' : 'FAIL';
  writeFileSync(
    join(OUT, `${id}.md`),
    `# ${id} — ${status}\n\n${body.trim()}\n`,
    'utf8',
  );
}

function skip(id, reason) {
  writeFileSync(
    join(OUT, `${id}.md`),
    `# ${id} — SKIPPED\n\n**Not executed in this HTTP runner.**\n\n${reason.trim()}\n`,
    'utf8',
  );
}

async function fetchJson(path, init) {
  const r = await fetch(`${BASE}${path}`, init);
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text };
  }
  return { ok: r.ok, status: r.status, data, text };
}

function ghCreateAndPush(repoShortName) {
  const dir = mkdtempSync(join(tmpdir(), `kanban-${repoShortName}-`));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), `# ${repoShortName}\n`, 'utf8');
  execSync('git add README.md && git commit -m init', { cwd: dir, shell: true, stdio: 'pipe' });
  execSync('git branch -M main', { cwd: dir, stdio: 'pipe' });
  execSync(
    `gh repo create ${ORG}/${repoShortName} --public --source=. --remote=origin --push --description "Kanban E2E ${repoShortName}"`,
    { cwd: dir, stdio: 'pipe' },
  );
  const remoteUrl = `https://github.com/${ORG}/${repoShortName}`;
  return { dir, remoteUrl, scmProject: `${ORG}/${repoShortName}` };
}

function projectBody(id, localPath, remoteUrl, scmProject, extra = {}) {
  return {
    id,
    name: id,
    issueIdPrefix: 'E2E',
    repository: {
      remoteUrl,
      localPath,
      baseBranch: 'main',
      sprintBranchPrefix: 'feature/',
      taskBranchPrefix: 'dev/',
      scmProvider: 'github',
      scmProject,
      ...extra.repository,
    },
    agents: [],
    ...extra,
  };
}

async function postProject(body) {
  return fetchJson('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Individual tests ─────────────────────────────────────────────

async function runP1() {
  const { ok, data } = await fetchJson('/health');
  writeCase(
    'P1',
    ok && data?.ok === true,
    ok && data?.ok === true
      ? `GET /health returned ok=true. (Board / JS not checked — requires browser.)`
      : `GET /health failed: ${JSON.stringify(data)}`,
  );
}

async function runSP1_SP2_SP3() {
  const repo = `agent-im-kanban-${RUN}-SP`;
  let local;
  try {
    const g = ghCreateAndPush(repo);
    local = g.dir;
    const pid = `e2e-sp-${RUN}`;
    const pr = await postProject(projectBody(pid, g.dir, g.remoteUrl, g.scmProject));
    if (!pr.ok) {
      writeCase('SP1', false, `POST /api/projects failed: ${pr.status} ${pr.text}`);
      writeCase('SP2', false, 'Depends on SP1 project');
      writeCase('SP3', false, 'Depends on SP1 project');
      return;
    }
    const sprintName = `sprint-${RUN}`;
    const s1 = await fetchJson('/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, sprintName }),
    });
    writeCase(
      'SP1',
      s1.ok && s1.data?.id,
      s1.ok
        ? `Sprint created: id=${s1.data?.id}; branchName=${s1.data?.branchName}`
        : `Expected 2xx, got ${s1.status}: ${s1.text}`,
    );
    const s2 = await fetchJson(`/api/sprints?projectId=${encodeURIComponent(pid)}`);
    const listOk = s2.ok && Array.isArray(s2.data) && s2.data.length > 0;
    writeCase(
      'SP2',
      listOk,
      listOk ? `GET /api/sprints returned ${s2.data.length} sprint(s).` : s2.text,
    );
    const dup = await fetchJson('/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, sprintName }),
    });
    writeCase(
      'SP3',
      !dup.ok && dup.status >= 400,
      !dup.ok
        ? `Duplicate sprint rejected with HTTP ${dup.status}: ${dup.text.slice(0, 500)}`
        : `Expected error for duplicate sprint, got ok`,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeCase('SP1', false, msg);
    writeCase('SP2', false, msg);
    writeCase('SP3', false, msg);
  } finally {
    if (local)
      try {
        rmSync(local, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
  }
}

async function runT1_T2_T3() {
  const repo = `agent-im-kanban-${RUN}-T`;
  let local;
  try {
    const g = ghCreateAndPush(repo);
    local = g.dir;
    const pid = `e2e-t-${RUN}`;
    const pr = await postProject(projectBody(pid, g.dir, g.remoteUrl, g.scmProject));
    if (!pr.ok) {
      writeCase('T1', false, pr.text);
      writeCase('T2', false, 'Depends on T project');
      writeCase('T3', false, 'Depends on T project');
      return;
    }
    const s = await fetchJson('/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, sprintName: `s-${RUN}` }),
    });
    if (!s.ok) {
      writeCase('T1', false, `Sprint start failed: ${s.text}`);
      writeCase('T2', false, 'Depends on sprint');
      writeCase('T3', false, 'Depends on sprint');
      return;
    }
    const sprintId = s.data.id;
    const issueId = `E2E-T1-${RUN}`;
    const c1 = await fetchJson('/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId,
        issueId,
        title: 'Normal task',
      }),
    });
    writeCase(
      'T1',
      c1.ok && c1.data?.workflowState === 'todo',
      c1.ok
        ? `task created workflowState=${c1.data?.workflowState}`
        : `${c1.status} ${c1.text}`,
    );
    const c2 = await fetchJson('/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId,
        issueId: `E2E-HF-${RUN}`,
        title: 'Hotfix',
        isHotfix: true,
      }),
    });
    writeCase(
      'T2',
      c2.ok && c2.data?.isHotfix === true,
      c2.ok
        ? `isHotfix=${c2.data?.isHotfix}`
        : `${c2.status} ${c2.text}`,
    );
    const dup = await fetchJson('/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId,
        issueId,
        title: 'dup',
      }),
    });
    writeCase(
      'T3',
      !dup.ok && dup.status >= 400,
      !dup.ok ? `Rejected: ${dup.status} ${dup.text.slice(0, 400)}` : 'Expected duplicate issueId error',
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    writeCase('T1', false, msg);
    writeCase('T2', false, msg);
    writeCase('T3', false, msg);
  } finally {
    if (local)
      try {
        rmSync(local, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
  }
}

async function runCV() {
  const repo = `agent-im-kanban-${RUN}-CV`;
  let local;
  try {
    const g = ghCreateAndPush(repo);
    local = g.dir;
    const pid = `e2e-cv-${RUN}`;
    const pr = await postProject(projectBody(pid, g.dir, g.remoteUrl, g.scmProject));
    if (!pr.ok) {
      for (const id of ['CV1', 'CV2', 'CV3', 'CV4', 'CV5', 'CV6'])
        writeCase(id, false, pr.text);
      return;
    }
    const g0 = await fetchJson(`/api/projects/${encodeURIComponent(pid)}/coverage`);
    const cov = g0.data?.coverage;
    writeCase(
      'CV1',
      g0.ok && (cov === 0 || cov === undefined || cov === null),
      JSON.stringify(g0.data),
    );
    const p78 = await fetchJson(`/api/projects/${encodeURIComponent(pid)}/coverage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverage: 78, context: 'e2e' }),
    });
    writeCase(
      'CV2',
      p78.ok && p78.data?.updated === true && Number(p78.data?.coverage) === 78,
      JSON.stringify(p78.data),
    );
    const p50 = await fetchJson(`/api/projects/${encodeURIComponent(pid)}/coverage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverage: 50 }),
    });
    writeCase(
      'CV3',
      p50.ok && p50.data?.updated === false && Number(p50.data?.coverage) === 78,
      JSON.stringify(p50.data),
    );
    const p78b = await fetchJson(`/api/projects/${encodeURIComponent(pid)}/coverage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverage: 78 }),
    });
    writeCase(
      'CV4',
      p78b.ok && p78b.data?.updated === false,
      JSON.stringify(p78b.data),
    );
    const hist = await fetchJson(`/api/projects/${encodeURIComponent(pid)}/coverage/history?limit=10`);
    const hok = hist.ok && Array.isArray(hist.data);
    writeCase(
      'CV5',
      hok,
      hist.text.slice(0, 800),
    );
    writeCase(
      'CV6',
      hok,
      'History endpoint reachable; lower-value rows may exist — see CV3 POST.',
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of ['CV1', 'CV2', 'CV3', 'CV4', 'CV5', 'CV6']) writeCase(id, false, msg);
  } finally {
    if (local)
      try {
        rmSync(local, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
  }
}

async function runEX3() {
  const bad = await fetchJson('/api/workflows/tasks/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'nonexistent-project-xyz',
      sprintId: '00000000-0000-0000-0000-000000000000',
      issueId: 'X-1',
      title: 't',
    }),
  });
  writeCase(
    'EX3',
    !bad.ok && bad.status >= 400,
    !bad.ok ? `Rejected as expected: ${bad.status} ${bad.text.slice(0, 400)}` : bad.text,
  );
}

/** EX1: illegal transition — close while todo */
async function runEX1() {
  const repo = `agent-im-kanban-${RUN}-EX1`;
  let local;
  try {
    const g = ghCreateAndPush(repo);
    local = g.dir;
    const pid = `e2e-ex1-${RUN}`;
    const pr = await postProject(projectBody(pid, g.dir, g.remoteUrl, g.scmProject));
    if (!pr.ok) {
      writeCase('EX1', false, pr.text);
      return;
    }
    const s = await fetchJson('/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, sprintName: `s-${RUN}` }),
    });
    if (!s.ok) {
      writeCase('EX1', false, `sprint: ${s.text}`);
      return;
    }
    const c = await fetchJson('/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: s.data.id,
        issueId: `E2E-EX1-${RUN}`,
        title: 'ex1',
      }),
    });
    if (!c.ok) {
      writeCase('EX1', false, c.text);
      return;
    }
    const tid = c.data.id;
    const cl = await fetchJson(`/api/workflows/tasks/${tid}/close`, { method: 'POST' });
    writeCase(
      'EX1',
      !cl.ok && cl.status >= 400,
      !cl.ok
        ? `close rejected from todo: HTTP ${cl.status} ${cl.text.slice(0, 500)}`
        : `Expected failure, got ${JSON.stringify(cl.data)}`,
    );
  } catch (e) {
    writeCase('EX1', false, e instanceof Error ? e.message : String(e));
  } finally {
    if (local)
      try {
        rmSync(local, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
  }
}

/** F3: testing/fail when not in testing */
async function runF3() {
  const repo = `agent-im-kanban-${RUN}-F3`;
  let local;
  try {
    const g = ghCreateAndPush(repo);
    local = g.dir;
    const pid = `e2e-f3-${RUN}`;
    const pr = await postProject(projectBody(pid, g.dir, g.remoteUrl, g.scmProject));
    if (!pr.ok) {
      writeCase('F3', false, pr.text);
      return;
    }
    const s = await fetchJson('/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, sprintName: `s-${RUN}` }),
    });
    if (!s.ok) {
      writeCase('F3', false, s.text);
      return;
    }
    const c = await fetchJson('/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: s.data.id,
        issueId: `E2E-F3-${RUN}`,
        title: 'f3',
      }),
    });
    if (!c.ok) {
      writeCase('F3', false, c.text);
      return;
    }
    const tid = c.data.id;
    const fail = await fetchJson(`/api/workflows/tasks/${tid}/testing/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'x', log: 'y' }),
    });
    writeCase(
      'F3',
      !fail.ok,
      !fail.ok
        ? `Non-2xx as expected: HTTP ${fail.status} ${fail.text.slice(0, 500)}`
        : `Expected error for testing/fail in todo, got ${JSON.stringify(fail.data)}`,
    );
  } catch (e) {
    writeCase('F3', false, e instanceof Error ? e.message : String(e));
  } finally {
    if (local)
      try {
        rmSync(local, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
  }
}

async function main() {
  await runP1();

  skip('P2', 'Requires UI `/projects` or manual POST; automated SP/T tests cover public repo project create via API.');
  skip('P3', 'Requires UI for private flag; use POST /api/projects with isPrivate in a dedicated run.');
  skip('P4', 'Requires project with requiresUat:true (UI or POST).');
  skip('P5', 'Requires coverageCommand in project settings (UI).');
  skip('P6', 'Manual: verify git fetch from localPath (environment-specific).');

  await runSP1_SP2_SP3();
  await runT1_T2_T3();
  skip('T4', 'UI validation — cannot assert without browser automation.');

  const runnerSkip =
    'Needs real runner / agent-dev / lane automation or UI (assign, handoff, worktree). Not covered by HTTP-only runner.';
  for (const id of ['A1', 'A2', 'A3', 'A4', 'A5']) skip(id, runnerSkip);

  for (const id of ['PT1', 'PT2', 'PT3']) skip(id, runnerSkip);
  for (const id of ['E1', 'E2', 'E3']) skip(id, runnerSkip);
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5']) skip(id, runnerSkip);
  for (const id of ['G1', 'G2', 'G3', 'G4']) skip(id, runnerSkip);

  skip(
    'G5',
    'Needs task in regression_testing; call refresh via API once state is prepared (full flow or fixture).',
  );

  const shSkip =
    'Needs private project + task in regression_testing with kanbanAgent=self-host-runner (merge PR flow).';
  for (const id of ['SH1', 'SH2', 'SH3', 'SH4', 'SH5', 'SH6']) skip(id, shSkip);

  for (const id of ['U1', 'U2', 'U3', 'U4']) skip(id, 'Requires requiresUat project + workflow positions.');
  for (const id of ['PR1', 'PR2', 'PR3']) skip(id, 'Requires pending_release tasks + UI or merge state.');
  for (const id of ['CL1', 'CL2', 'CL3', 'CL4', 'CL5', 'CL6', 'CL7']) skip(id, 'Async close + worktree + tests — not in HTTP-only runner.');

  for (const id of ['B1', 'B2', 'B3', 'B4']) skip(id, runnerSkip);
  for (const id of ['HF1', 'HF2', 'HF3']) skip(id, 'Covered partially by T2; full path needs runners.');

  await runCV();
  for (const id of ['CV7', 'CV8', 'CV9']) skip(id, 'Requires regression flow with coverage thresholds (runners).');

  for (const id of ['F1', 'F2']) skip(id, 'Needs task in testing/regression with correct state.');
  await runF3();

  skip('FULL-16', 'Narrative full path — manual or Playwright.');
  skip('FULL-17', 'Private full path — manual; needs SH CI flow.');

  await runEX1();
  skip('EX2', 'Concurrency — manual.');
  await runEX3();
  skip('EX4', 'Needs two projects/sprints mismatch setup.');
  skip('EX5', 'Database migration — manual upgrade test.');
  skip('EX6', 'Crash simulation — manual.');
  skip('EX7', 'Needs task already past regression — manual.');

  writeFileSync(
    join(OUT, 'README.md'),
    `# Kanban test results (${RUN})\n\n` +
      `Source: \`docs/KANBAN-TESTCASES.md\`\n\n` +
      `Server: \`${BASE}\`\n` +
      `GitHub org for repos: \`${ORG}\`\n\n` +
      `Generated by \`scripts/kanban-doc-test-runner.mjs\`.\n`,
    'utf8',
  );

  console.log(`Done. Results in ${OUT}/ (run id ${RUN})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
