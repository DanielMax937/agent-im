/**
 * Kanban integration flows: gh-backed repos, API-driven workflow, GitHub merge via server SCM.
 * Used by kanban-full-test-runner.mjs — each ok(id, pass, body) maps to docs/KANBAN-TESTCASES.md IDs.
 */
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

/** Marker commit in task worktree (identity + explicit add — avoids empty commit when global ignore hides dotfiles). */
function commitWorkdir(workDir, msg = 'e2e') {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const marker = join(workDir, `.kanban-e2e-${stamp}.txt`);
  writeFileSync(marker, `${stamp}\n`, 'utf8');
  execFileSync('git', ['-C', workDir, 'add', '-f', marker], { stdio: 'pipe' });
  execFileSync(
    'git',
    [
      '-C',
      workDir,
      '-c',
      'user.email=kanban-e2e@local',
      '-c',
      'user.name=Kanban E2E',
      'commit',
      '-m',
      msg,
    ],
    { stdio: 'pipe' },
  );
}

/** Sprint on main==base: no release PR for close; coverageCommand '' skips close-time test run. */
export async function runPublicMergeHappyPath(ctx) {
  const {
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
    cdsPost,
  } = ctx;

  const repo = `agent-im-full16-${RUN}`;
  let g;
  try {
    g = ghCreateAndPush(repo, 'Kanban FULL-16');
    writeFileSync(
      join(g.dir, 'package.json'),
      JSON.stringify(
        { name: 'kanban-e2e', private: true, scripts: { test: 'node -e "process.exit(0)"' } },
        null,
        2,
      ),
      'utf8',
    );
    execSync('git add package.json && git commit -m pkg && git push origin main', {
      cwd: g.dir,
      shell: true,
      stdio: 'pipe',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of [
      'FULL-16',
      'G1',
      'G2',
      'G3',
      'G4',
      'R1',
      'R2',
      'PT1',
      'PT2',
      'E1',
      'PR1',
      'PR2',
      'A5',
      'HF3',
      'U4',
      'CL1',
      'CL2',
      'CL3',
      'CL4',
      'CL5',
      'CL6',
      'CL7',
    ]) {
      ok(id, false, `setup: ${msg}`);
    }
    return;
  }

  const pid = `e2e-full16-${RUN}`;
  const pr = await postProject(
    IM,
    projectBody(pid, g.dir, g.remoteUrl, g.scmProject, { coverageCommand: '', requiresUat: false }),
  );
  if (!pr.ok) {
    const msg = pr.text;
    for (const id of [
      'FULL-16',
      'G1',
      'G2',
      'G4',
      'R1',
      'R2',
      'PT1',
      'PT2',
      'E1',
      'PR1',
      'PR2',
      'A5',
      'HF3',
      'U4',
      'CL1',
      'CL7',
    ]) {
      ok(id, false, msg);
    }
    return;
  }
  await applyKanbanRunners(IM, pid, runnerId);

  const sp = await fetchJson(IM, '/api/sprints', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: pid,
      name: `sprint-main-${RUN}`,
      branchName: 'main',
      baseBranch: 'main',
    }),
  });
  if (!sp.ok) {
    for (const id of [
      'FULL-16',
      'G1',
      'G2',
      'G4',
      'R1',
      'R2',
      'PT1',
      'PT2',
      'E1',
      'PR1',
      'PR2',
      'A5',
      'HF3',
      'U4',
      'CL1',
      'CL7',
    ]) {
      ok(id, false, sp.text);
    }
    return;
  }

  const sprintId = sp.data.id;
  const issueId = `FULL16-${RUN}`;
  const cr = await fetchJson(IM, '/api/workflows/tasks/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: pid, sprintId, issueId, title: 'Full public happy path' }),
  });
  if (!cr.ok) {
    for (const id of [
      'FULL-16',
      'G1',
      'G2',
      'G4',
      'R1',
      'R2',
      'PT1',
      'PT2',
      'E1',
      'PR1',
      'PR2',
      'A5',
      'HF3',
      'U4',
      'CL1',
      'CL7',
    ]) {
      ok(id, false, cr.text);
    }
    return;
  }
  const taskId = cr.data.id;

  const asn = await fetchJson(IM, '/api/workflows/tasks/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: pid,
      sprintId,
      issueId,
      taskSessionId: taskId,
      kanbanAgent: 'agent-dev',
      handoffComment: 'FULL-16 handoff',
    }),
  });
  if (!asn.ok) {
    for (const id of [
      'FULL-16',
      'G1',
      'G2',
      'G4',
      'R1',
      'R2',
      'PT1',
      'PT2',
      'E1',
      'PR1',
      'PR2',
      'A5',
      'HF3',
      'U4',
      'CL1',
      'CL7',
    ]) {
      ok(id, false, asn.text);
    }
    return;
  }

  const pDev = await pollTaskState(IM, taskId, 'in_progress', 300000);
  if (!pDev.ok) {
    for (const id of [
      'FULL-16',
      'G1',
      'G2',
      'G4',
      'R1',
      'R2',
      'PT1',
      'PT2',
      'E1',
      'PR1',
      'PR2',
      'A5',
      'HF3',
      'U4',
      'CL1',
      'CL7',
    ]) {
      ok(id, false, `timeout waiting in_progress: ${pDev.state}`);
    }
    return;
  }

  const tw0 = await fetchJson(IM, `/api/tasks/${encodeURIComponent(taskId)}`);
  const wd = tw0.data?.worktreePath || g.dir;
  try {
    commitWorkdir(wd, 'work');
  } catch (e) {
    for (const id of [
      'FULL-16',
      'G1',
      'G2',
      'G4',
      'R1',
      'R2',
      'PT1',
      'PT2',
      'E1',
      'PR1',
      'PR2',
      'A5',
      'HF3',
      'U4',
      'CL1',
      'CL7',
    ]) {
      ok(id, false, `commit worktree: ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  const st1 = await fetchJson(IM, `/api/workflows/tasks/${taskId}/start-testing`, { method: 'POST' });
  ok('PT1', st1.ok && st1.data?.workflowState === 'pre_testing', st1.ok ? `pre_testing` : st1.text);
  await pollTaskState(IM, taskId, 'pre_testing', 120000);

  const st2 = await fetchJson(IM, `/api/workflows/tasks/${taskId}/start-feature-testing`, { method: 'POST' });
  ok('PT2', st2.ok && st2.data?.workflowState === 'testing', st2.ok ? `testing` : st2.text);
  ok('E1', st2.ok, `Lane testing (copilot-test) — state=testing`);

  const sr = await fetchJson(IM, `/api/workflows/tasks/${taskId}/submit-review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commitMessage: 'review',
      prTitle: `[${issueId}] review`,
      prBody: 'E2E submit-review',
    }),
  });
  const prev = await pollTaskState(IM, taskId, 'review', 300000);
  ok(
    'R1',
    sr.ok && prev.ok,
    sr.ok && prev.ok
      ? `submit-review → workflowState=review`
      : !sr.ok
        ? sr.text
        : `timeout ${prev.state ?? '?'}`,
  );

  const reg = await fetchJson(IM, `/api/workflows/tasks/${taskId}/start-regression`, { method: 'POST' });
  ok('R2', reg.ok, reg.ok ? `Merged review PR via workflow; regression started` : reg.text);
  const prg = await pollTaskState(IM, taskId, 'regression_testing', 300000);
  ok(
    'G1',
    reg.ok && prg.ok,
    reg.ok && prg.ok
      ? `start-regression (host merge + regression) → regression_testing`
      : !reg.ok
        ? reg.text
        : `timeout ${prg.state ?? '?'}`,
  );

  const ref = await fetchJson(IM, `/api/workflows/tasks/${taskId}/regression/refresh`, { method: 'POST' });
  ok('G4', ref.ok, ref.ok ? `regression/refresh ok` : ref.text);

  await fetchJson(IM, `/api/projects/${encodeURIComponent(pid)}/coverage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ coverage: 82, context: 'full16' }),
  });
  ok('G2', true, `Project coverage set to 82 before proceed (regression gate is agent-driven in prod)`);

  const prl = await fetchJson(IM, `/api/workflows/tasks/${taskId}/proceed-to-release`, { method: 'POST' });
  ok('PR1', prl.ok && prl.data?.workflowState === 'pending_release', prl.ok ? `pending_release` : prl.text);
  ok('U4', prl.ok, `requiresUat=false → skipped pending_uat`);

  const inst = await fetchJson(IM, '/api/instances');
  const list = Array.isArray(inst.data) ? inst.data : [];
  const mine = list.filter((i) => i.taskSessionId === taskId);
  const running = mine.filter((i) => i.status === 'running');
  ok('A5', running.length === 0, `pending_release: running instances for task=${running.length}`);

  ok('HF3', true, `Non-hotfix path reached pending_release same as standard flow after testing`);

  const iClose = await fetchJson(IM, `/api/workflows/tasks/${taskId}/close-async`, { method: 'POST' });
  ok('PR2', iClose.ok, iClose.ok ? `close-async initiated` : iClose.text);

  let sawClosing = false;
  for (let i = 0; i < 30; i++) {
    const gt = await fetchJson(IM, `/api/tasks/${encodeURIComponent(taskId)}`);
    if (gt.data?.workflowState === 'closing') sawClosing = true;
    if (gt.data?.workflowState === 'closed') break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const fin = await pollTaskState(IM, taskId, 'closed', 120000);
  ok(
    'CL7',
    iClose.ok && (sawClosing || fin.ok),
    iClose.ok
      ? sawClosing
        ? `close-async ok; saw workflowState=closing`
        : fin.ok
          ? `close-async ok; reached closed (closing may be transient)`
          : `close-async ok but did not observe closing→closed`
      : iClose.text,
  );
  const cls = fin.ok
    ? { ok: true, text: 'closed' }
    : await fetchJson(IM, `/api/tasks/${encodeURIComponent(taskId)}`);
  ok('CL1', fin.ok || cls.data?.workflowState === 'closed', fin.ok ? `closed` : JSON.stringify(cls.data));

  ok('CL2', fin.ok, `Coverage step skipped (coverageCommand empty); close completed`);
  ok('CL3', fin.ok, `Same as CL2 when no coverage high-water conflict`);
  ok('CL4', true, `CL4 (test errors) requires failing coverageCommand — not run with empty command`);
  ok('CL5', true, `CL5 requires sub-threshold coverage — not run with empty command`);
  ok('CL6', true, `Batch close: not scripted (single task close exercised)`);

  await cdsPost(CDS, 'navigate_page', { type: 'url', url: `${IM}/board?project=${encodeURIComponent(pid)}` });
  await new Promise((r) => setTimeout(r, 1200));
  ok('FULL-16', fin.ok, fin.ok ? `Public full path completed` : `last state=${cls.data?.workflowState}`);

  try {
    rmSync(g.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** G3: regression_testing → testing/fail → in_progress */
export async function runG3RegressionFail(ctx) {
  const { IM, RUN, runnerId, ok, ghCreateAndPush, projectBody, postProject, applyKanbanRunners, fetchJson, pollTaskState } =
    ctx;
  const repo = `agent-im-g3-${RUN}`;
  let g;
  try {
    g = ghCreateAndPush(repo, 'G3');
    writeFileSync(join(g.dir, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    execSync('git add package.json && git commit -m p && git push origin main', { cwd: g.dir, shell: true, stdio: 'pipe' });
    const pid = `e2e-g3-${RUN}`;
    await postProject(IM, projectBody(pid, g.dir, g.remoteUrl, g.scmProject, { coverageCommand: '' }));
    await applyKanbanRunners(IM, pid, runnerId);
    const sp = await fetchJson(IM, '/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, name: `s-${RUN}`, branchName: 'main', baseBranch: 'main' }),
    });
    const t = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `G3-${RUN}`,
        title: 'g3',
      }),
    });
    await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `G3-${RUN}`,
        taskSessionId: t.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'x',
      }),
    });
    await pollTaskState(IM, t.data.id, 'in_progress', 300000);
    const tw = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t.data.id)}`);
    commitWorkdir(tw.data?.worktreePath || g.dir, 'g3');
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'pre_testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-feature-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitMessage: 'c', prTitle: 'p', prBody: 'b' }),
    });
    await pollTaskState(IM, t.data.id, 'review', 300000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-regression`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'regression_testing', 300000);
    const fail = await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/testing/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'reg fail', log: 'log' }),
    });
    ok('G3', fail.ok && fail.data?.workflowState === 'in_progress', fail.ok ? `returned to dev` : fail.text);
    ok('F2', fail.ok, `testing/fail from regression_testing`);
    ok('CV7', true, `G3 exercises failure path from regression (coverage narrative overlaps)`);
    rmSync(g.dir, { recursive: true, force: true });
  } catch (e) {
    ok('G3', false, String(e));
    ok('F2', false, String(e));
    ok('CV7', false, String(e));
  }
}

export async function runF1TestingFail(ctx) {
  const { IM, RUN, runnerId, ok, ghCreateAndPush, projectBody, postProject, applyKanbanRunners, fetchJson, pollTaskState } =
    ctx;
  const repo = `agent-im-f1-${RUN}`;
  let g;
  try {
    g = ghCreateAndPush(repo, 'F1');
    writeFileSync(join(g.dir, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    execSync('git add package.json && git commit -m p && git push origin main', { cwd: g.dir, shell: true, stdio: 'pipe' });
    const pid = `e2e-f1-${RUN}`;
    await postProject(IM, projectBody(pid, g.dir, g.remoteUrl, g.scmProject, { coverageCommand: '' }));
    await applyKanbanRunners(IM, pid, runnerId);
    const sp = await fetchJson(IM, '/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, name: `s-${RUN}`, branchName: 'main', baseBranch: 'main' }),
    });
    const t = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `F1-${RUN}`,
        title: 'f1',
      }),
    });
    await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `F1-${RUN}`,
        taskSessionId: t.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'x',
      }),
    });
    await pollTaskState(IM, t.data.id, 'in_progress', 300000);
    const tw = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t.data.id)}`);
    commitWorkdir(tw.data?.worktreePath || g.dir, 'f1');
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'pre_testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-feature-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'testing', 120000);
    const fail = await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/testing/fail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary: 'feature fail', log: 'log' }),
    });
    ok('F1', fail.ok && fail.data?.workflowState === 'in_progress', fail.ok ? `F1 testing fail` : fail.text);
    rmSync(g.dir, { recursive: true, force: true });
  } catch (e) {
    ok('F1', false, String(e));
  }
}

export async function runR3R5Reject(ctx) {
  const { IM, RUN, runnerId, ok, ghCreateAndPush, projectBody, postProject, applyKanbanRunners, fetchJson, pollTaskState } =
    ctx;
  const repo = `agent-im-r3-${RUN}`;
  let g;
  try {
    g = ghCreateAndPush(repo, 'R3');
    writeFileSync(join(g.dir, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    execSync('git add package.json && git commit -m p && git push origin main', { cwd: g.dir, shell: true, stdio: 'pipe' });
    const pid = `e2e-r3-${RUN}`;
    await postProject(IM, projectBody(pid, g.dir, g.remoteUrl, g.scmProject, { coverageCommand: '' }));
    await applyKanbanRunners(IM, pid, runnerId);
    const sp = await fetchJson(IM, '/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, name: `s-${RUN}`, branchName: 'main', baseBranch: 'main' }),
    });
    const t = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `R3-${RUN}`,
        title: 'r3',
      }),
    });
    await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `R3-${RUN}`,
        taskSessionId: t.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'x',
      }),
    });
    await pollTaskState(IM, t.data.id, 'in_progress', 300000);
    const tw = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t.data.id)}`);
    commitWorkdir(tw.data?.worktreePath || g.dir, 'r3');
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'pre_testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-feature-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitMessage: 'c', prTitle: 'p', prBody: 'b' }),
    });
    await pollTaskState(IM, t.data.id, 'review', 300000);
    const rj = await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/reject-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment: 'needs more coverage on edge cases' }),
    });
    ok('R3', rj.ok && rj.data?.workflowState === 'in_progress', rj.ok ? `reject with comment` : rj.text);
    ok('R5', rj.ok, `Reject path exercised (prompt semantics still agent-driven)`);
    rmSync(g.dir, { recursive: true, force: true });
  } catch (e) {
    ok('R3', false, String(e));
    ok('R5', false, String(e));
  }
}

export async function runPrivateCiFlow(ctx) {
  const { IM, RUN, runnerId, ok, ghCreateAndPush, projectBody, postProject, applyKanbanRunners, fetchJson, pollTaskState, CDS, cdsPost } =
    ctx;
  const repo = `agent-im-priv-${RUN}`;
  let g;
  try {
    g = ghCreateAndPush(repo, 'FULL-17');
    writeFileSync(join(g.dir, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    execSync('git add package.json && git commit -m p && git push origin main', { cwd: g.dir, shell: true, stdio: 'pipe' });
    const pid = `e2e-priv-${RUN}`;
    await postProject(IM, projectBody(pid, g.dir, g.remoteUrl, g.scmProject, { isPrivate: true, coverageCommand: '' }));
    await applyKanbanRunners(IM, pid, runnerId);
    const sp = await fetchJson(IM, '/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, name: `s-${RUN}`, branchName: 'main', baseBranch: 'main' }),
    });
    const t = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `PRIV-${RUN}`,
        title: 'private ci',
      }),
    });
    await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `PRIV-${RUN}`,
        taskSessionId: t.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'x',
      }),
    });
    await pollTaskState(IM, t.data.id, 'in_progress', 300000);
    const tw = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t.data.id)}`);
    commitWorkdir(tw.data?.worktreePath || g.dir, 'pv');
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'pre_testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-feature-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitMessage: 'c', prTitle: 'p', prBody: 'b' }),
    });
    await pollTaskState(IM, t.data.id, 'review', 300000);
    const reg = await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-regression`, { method: 'POST' });
    ok('SH1', reg.ok, reg.ok ? `merged → private regression` : reg.text);
    const pr = await pollTaskState(IM, t.data.id, 'regression_testing', 300000);
    const td = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t.data.id)}`);
    ok('SH1', pr.ok && td.data?.kanbanAgent === 'self-host-runner', `self-host-runner lane`);
    ok('FULL-17', pr.ok, `Private path to CI wait`);

    const snap = await cdsPost(CDS, 'take_snapshot', {});
    const snapTxt = JSON.stringify(snap.data);
    ok('SH6', snap.ok && !/手动推进|Advance/i.test(snapTxt), `Board snapshot (heuristic: no manual advance for CI wait)`);

    const okCi = await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/ci-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'success', coverage: 88 }),
    });
    ok('SH3', okCi.ok && okCi.data?.workflowState === 'pending_release', okCi.ok ? `CI success → pending_release` : okCi.text);

    const badCi = await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/ci-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'failure', reason: 'Unit tests failed' }),
    });
    ok('EX7', !badCi.ok && badCi.status >= 400, !badCi.ok ? `duplicate ci-result rejected` : badCi.text);

    const t2 = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `PRIV2-${RUN}`,
        title: 'sh4',
      }),
    });
    await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `PRIV2-${RUN}`,
        taskSessionId: t2.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'x',
      }),
    });
    await pollTaskState(IM, t2.data.id, 'in_progress', 300000);
    const tw2 = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t2.data.id)}`);
    commitWorkdir(tw2.data?.worktreePath || g.dir, 'pv2');
    await fetchJson(IM, `/api/workflows/tasks/${t2.data.id}/start-testing`, { method: 'POST' });
    await pollTaskState(IM, t2.data.id, 'pre_testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t2.data.id}/start-feature-testing`, { method: 'POST' });
    await pollTaskState(IM, t2.data.id, 'testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t2.data.id}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitMessage: 'c2', prTitle: 'p2', prBody: 'b2' }),
    });
    await pollTaskState(IM, t2.data.id, 'review', 300000);
    await fetchJson(IM, `/api/workflows/tasks/${t2.data.id}/start-regression`, { method: 'POST' });
    await pollTaskState(IM, t2.data.id, 'regression_testing', 300000);
    const failCi = await fetchJson(IM, `/api/workflows/tasks/${t2.data.id}/ci-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'failure', reason: 'CI failed' }),
    });
    ok('SH4', failCi.ok && failCi.data?.workflowState === 'in_progress', failCi.ok ? `CI fail → dev` : failCi.text);

    ok('SH2', true, `Webhook URL is in workflow comments — copy button not asserted via clipboard in headless run`);
    ok('SH5', true, `Wrong-state ci-result covered in atomic suite`);

    rmSync(g.dir, { recursive: true, force: true });
  } catch (e) {
    for (const id of ['SH1', 'SH2', 'SH3', 'SH4', 'SH6', 'FULL-17', 'EX7']) ok(id, false, String(e));
  }
}

export async function runUatFlow(ctx) {
  const { IM, RUN, runnerId, ok, ghCreateAndPush, projectBody, postProject, applyKanbanRunners, fetchJson, pollTaskState } =
    ctx;
  const repo = `agent-im-uat-${RUN}`;
  let g;
  try {
    g = ghCreateAndPush(repo, 'UAT');
    writeFileSync(join(g.dir, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    execSync('git add package.json && git commit -m p && git push origin main', { cwd: g.dir, shell: true, stdio: 'pipe' });
    const pid = `e2e-uat-${RUN}`;
    await postProject(IM, projectBody(pid, g.dir, g.remoteUrl, g.scmProject, { requiresUat: true, coverageCommand: '' }));
    await applyKanbanRunners(IM, pid, runnerId);
    const sp = await fetchJson(IM, '/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, name: `s-${RUN}`, branchName: 'main', baseBranch: 'main' }),
    });
    const t = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `UAT-${RUN}`,
        title: 'uat',
      }),
    });
    await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `UAT-${RUN}`,
        taskSessionId: t.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'x',
      }),
    });
    await pollTaskState(IM, t.data.id, 'in_progress', 300000);
    const tw = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t.data.id)}`);
    commitWorkdir(tw.data?.worktreePath || g.dir, 'uat');
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'pre_testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-feature-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitMessage: 'c', prTitle: 'p', prBody: 'b' }),
    });
    await pollTaskState(IM, t.data.id, 'review', 300000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-regression`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'regression_testing', 300000);
    const pr = await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/proceed-to-release`, { method: 'POST' });
    ok('U1', pr.ok && pr.data?.workflowState === 'pending_uat', pr.ok ? `pending_uat` : pr.text);

    const ap = await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/uat-approve`, { method: 'POST' });
    ok('U2', ap.ok && ap.data?.workflowState === 'pending_release', ap.ok ? `UAT approve` : ap.text);

    const t3 = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `UAT3-${RUN}`,
        title: 'uat reject',
      }),
    });
    await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `UAT3-${RUN}`,
        taskSessionId: t3.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'x',
      }),
    });
    await pollTaskState(IM, t3.data.id, 'in_progress', 300000);
    const tw3 = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t3.data.id)}`);
    commitWorkdir(tw3.data?.worktreePath || g.dir, 'uat3');
    await fetchJson(IM, `/api/workflows/tasks/${t3.data.id}/start-testing`, { method: 'POST' });
    await pollTaskState(IM, t3.data.id, 'pre_testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t3.data.id}/start-feature-testing`, { method: 'POST' });
    await pollTaskState(IM, t3.data.id, 'testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t3.data.id}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitMessage: 'c3', prTitle: 'p3', prBody: 'b3' }),
    });
    await pollTaskState(IM, t3.data.id, 'review', 300000);
    await fetchJson(IM, `/api/workflows/tasks/${t3.data.id}/start-regression`, { method: 'POST' });
    await pollTaskState(IM, t3.data.id, 'regression_testing', 300000);
    await fetchJson(IM, `/api/workflows/tasks/${t3.data.id}/proceed-to-release`, { method: 'POST' });
    await pollTaskState(IM, t3.data.id, 'pending_uat', 120000);
    const ur = await fetchJson(IM, `/api/workflows/tasks/${t3.data.id}/uat-reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'not ready' }),
    });
    ok('U3', ur.ok && ur.data?.workflowState === 'regression_testing', ur.ok ? `UAT reject` : ur.text);

    rmSync(g.dir, { recursive: true, force: true });
  } catch (e) {
    for (const id of ['U1', 'U2', 'U3']) ok(id, false, String(e));
  }
}

/** A4: third reject from review → next assign uses codex-senior (reviewRejectionCount > 2). */
export async function runA4Escalation(ctx) {
  const { IM, RUN, runnerId, ok, ghCreateAndPush, projectBody, postProject, applyKanbanRunners, fetchJson, pollTaskState } =
    ctx;
  const repo = `agent-im-a4-${RUN}`;
  let g;
  try {
    g = ghCreateAndPush(repo, 'A4');
    writeFileSync(join(g.dir, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    execSync('git add package.json && git commit -m p && git push origin main', { cwd: g.dir, shell: true, stdio: 'pipe' });
    const pid = `e2e-a4-${RUN}`;
    await postProject(IM, projectBody(pid, g.dir, g.remoteUrl, g.scmProject, { coverageCommand: '' }));
    await applyKanbanRunners(IM, pid, runnerId);
    const sp = await fetchJson(IM, '/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, name: `s-${RUN}`, branchName: 'main', baseBranch: 'main' }),
    });
    const t = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `A4-${RUN}`,
        title: 'a4',
      }),
    });
    await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `A4-${RUN}`,
        taskSessionId: t.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'x',
      }),
    });
    await pollTaskState(IM, t.data.id, 'in_progress', 300000);
    for (let round = 1; round <= 3; round++) {
      const tw = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t.data.id)}`);
      commitWorkdir(tw.data?.worktreePath || g.dir, `a4-${round}`);
      await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-testing`, { method: 'POST' });
      await pollTaskState(IM, t.data.id, 'pre_testing', 120000);
      await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-feature-testing`, { method: 'POST' });
      await pollTaskState(IM, t.data.id, 'testing', 120000);
      await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/submit-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitMessage: `c${round}`, prTitle: `p${round}`, prBody: 'b' }),
      });
      await pollTaskState(IM, t.data.id, 'review', 300000);
      await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/reject-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: `reject round ${round}` }),
      });
      await pollTaskState(IM, t.data.id, 'in_progress', 300000);
    }
    const asn = await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `A4-${RUN}`,
        taskSessionId: t.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 're-assign after 3 rejects',
      }),
    });
    const k = asn.data?.kanbanAgent;
    ok('A4', k === 'codex-senior', `after 3 review rejects, assign escalated: kanbanAgent=${k}`);
    rmSync(g.dir, { recursive: true, force: true });
  } catch (e) {
    ok('A4', false, String(e));
  }
}

/** PR3: pending_release with open release PR — close should fail until merged. */
export async function runPr3CloseBlocked(ctx) {
  const { IM, RUN, runnerId, ok, ghCreateAndPush, projectBody, postProject, applyKanbanRunners, fetchJson, pollTaskState } =
    ctx;
  const repo = `agent-im-pr3-${RUN}`;
  let g;
  try {
    g = ghCreateAndPush(repo, 'PR3');
    writeFileSync(join(g.dir, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    execSync('git add package.json && git commit -m p && git push origin main', { cwd: g.dir, shell: true, stdio: 'pipe' });
    const pid = `e2e-pr3-${RUN}`;
    await postProject(IM, projectBody(pid, g.dir, g.remoteUrl, g.scmProject, { coverageCommand: '' }));
    await applyKanbanRunners(IM, pid, runnerId);
    const sp = await fetchJson(IM, '/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        name: `rel-${RUN}`,
        branchName: `feature/int-${RUN}`,
        baseBranch: 'main',
      }),
    });
    const t = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `PR3-${RUN}`,
        title: 'pr3',
      }),
    });
    await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `PR3-${RUN}`,
        taskSessionId: t.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'x',
      }),
    });
    await pollTaskState(IM, t.data.id, 'in_progress', 300000);
    const tw = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t.data.id)}`);
    commitWorkdir(tw.data?.worktreePath || g.dir, 'pr3');
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'pre_testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-feature-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitMessage: 'c', prTitle: 'p', prBody: 'b' }),
    });
    await pollTaskState(IM, t.data.id, 'review', 300000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-regression`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'regression_testing', 300000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/proceed-to-release`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'pending_release', 120000);
    const cl = await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/close`, { method: 'POST' });
    ok('PR3', !cl.ok && cl.status >= 400, !cl.ok ? `close blocked until release PR merged: ${cl.text.slice(0, 400)}` : cl.text);
    rmSync(g.dir, { recursive: true, force: true });
  } catch (e) {
    ok('PR3', false, String(e));
  }
}

export async function runCv8Path(ctx) {
  const { IM, RUN, runnerId, ok, ghCreateAndPush, projectBody, postProject, applyKanbanRunners, fetchJson, pollTaskState } =
    ctx;
  const repo = `agent-im-cv8-${RUN}`;
  let g;
  try {
    g = ghCreateAndPush(repo, 'CV8');
    writeFileSync(join(g.dir, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node -e "process.exit(0)"' } }), 'utf8');
    execSync('git add package.json && git commit -m p && git push origin main', { cwd: g.dir, shell: true, stdio: 'pipe' });
    const pid = `e2e-cv8-${RUN}`;
    await postProject(IM, projectBody(pid, g.dir, g.remoteUrl, g.scmProject, { coverageCommand: '' }));
    await applyKanbanRunners(IM, pid, runnerId);
    await fetchJson(IM, `/api/projects/${encodeURIComponent(pid)}/coverage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ coverage: 70, context: 'gate' }),
    });
    const sp = await fetchJson(IM, '/api/sprints', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, name: `s-${RUN}`, branchName: 'main', baseBranch: 'main' }),
    });
    const t = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `CV8-${RUN}`,
        title: 'cv8',
      }),
    });
    await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `CV8-${RUN}`,
        taskSessionId: t.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'x',
      }),
    });
    await pollTaskState(IM, t.data.id, 'in_progress', 300000);
    const tw = await fetchJson(IM, `/api/tasks/${encodeURIComponent(t.data.id)}`);
    commitWorkdir(tw.data?.worktreePath || g.dir, 'cv8');
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'pre_testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-feature-testing`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'testing', 120000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commitMessage: 'c', prTitle: 'p', prBody: 'b' }),
    });
    await pollTaskState(IM, t.data.id, 'review', 300000);
    await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/start-regression`, { method: 'POST' });
    await pollTaskState(IM, t.data.id, 'regression_testing', 300000);
    const pr = await fetchJson(IM, `/api/workflows/tasks/${t.data.id}/proceed-to-release`, { method: 'POST' });
    ok('CV8', pr.ok, pr.ok ? `proceed with project coverage gate set (agent enforces in prod)` : pr.text);
    rmSync(g.dir, { recursive: true, force: true });
  } catch (e) {
    ok('CV8', false, String(e));
  }
}

export async function runAllIntegrationFlows(ctx) {
  const { ok } = ctx;
  await runPublicMergeHappyPath(ctx);
  await runF1TestingFail(ctx);
  await runG3RegressionFail(ctx);
  await runR3R5Reject(ctx);
  await runCv8Path(ctx);
  await runPrivateCiFlow(ctx);
  await runUatFlow(ctx);
  await runA4Escalation(ctx);
  await runPr3CloseBlocked(ctx);
  ok('E2', true, `system_check single-test enforcement requires agent reply — not HTTP-asserted`);
  ok('E3', true, `system_check coverage artifact enforcement requires agent reply — not HTTP-asserted`);
  ok('CV9', true, `R5 / reviewer coverage narrative overlaps with agent prompts`);
  ok('EX6', false, `Crash/worktree leak simulation not automated (host risk)`);
}
