#!/usr/bin/env node
/**
 * Full Kanban testcase runner for docs/KANBAN-TESTCASES.md — every case ID is PASS or FAIL (never SKIPPED).
 *
 * Prerequisites:
 *   - agent-im listening (default http://127.0.0.1:3300)
 *   - gh auth login; GITHUB_TOKEN / gh token for SCM
 *   - At least one platform runner: GET /api/platform/runners (applied to all Kanban lanes per project)
 *
 * Env:
 *   AGENT_IM_BASE_URL       default http://127.0.0.1:3300
 *   CDS_BASE_URL            default http://127.0.0.1:9223
 *   KANBAN_E2E_ORG          optional GitHub org for gh repo create; else `gh api user` (§8 private flow defaults to bitstripecn)
 *   KANBAN_E2E_GHA_RUNS_ON  comma-separated GitHub Actions runs-on labels for §8 workflow (default self-hosted only). Add labels only when your org’s runner registration requires extra labels to match.
 *   CTI_KANBAN_PLATFORM_DIR optional absolute/relative platform dir for EX5 sqlite check (see JsonPlatformStore)
 *   CTI_KANBAN_CONFIRMATION_MAX_LOOPS  must match the running agent-im process (code default 10; `npm test` / e2e auto-dev set 10)
 *   KANBAN_FULL_STRICT=1    exit 1 if any testcase FAIL (default: exit 0 after completing the run)
 *   KANBAN_FULL_ONLY=p0    run only docs §0 (P1–P6)；skips runner list / later sections
 *   KANBAN_FULL_ONLY=p1    run only docs §1 Sprint (SP1–SP3); requires runner + agent-im + gh
 *   KANBAN_FULL_ONLY=p2    run only docs §2 todo (T1–T3)；requires runner + agent-im + gh
 *   KANBAN_FULL_ONLY=p3    run only docs §3 in_progress (A1,A3–A5；A2 手工); gh + long polls (see kanban-test-flows)
 *   KANBAN_FULL_ONLY=p4    run only docs §4 预测试 pre_testing (PT1–PT3); gh + runner polls
 *   KANBAN_FULL_ONLY=p5    run only docs §5 功能测试 testing (E1–E3); gh + runner polls
 *   KANBAN_FULL_ONLY=p6    run only docs §6 评审 review (R1–R5); gh + long polls
 *   KANBAN_FULL_ONLY=p7    run only docs §7 回归 regression_testing 公开仓库 (G1–G5); gh + long polls
 *   KANBAN_FULL_ONLY=p8    run only docs §8 回归 私有仓 self-host-runner (SH0–SH5); gh + long polls + GHA self-hosted verification
 *   KANBAN_FULL_ONLY=p9    run only docs §9 UAT (U1–U3); gh + runner polls (U4 requiresUat=false 见全量或其它用例)
 *   KANBAN_FULL_ONLY=p10   run only docs §10 待发布 (PR1–PR3); gh + runner (PR1/PR2 走 FULL-16 公开路径，同次 run 会写入 FULL-16/CL* 等 ID)
 *   KANBAN_FULL_ONLY=p11   run only docs §11 关单 (CL1–CL7, close-async / PR2+CL7); `runPublicMergeHappyPath` + `runSection11Cl4Cl5Cl6`（CL4/CL5 独立仓库、CL6 双任务串行 close）
 *   KANBAN_FULL_ONLY=p12   run only docs §12 阻塞 blocked (B1–B4); gh + runner (`runBlockedSection12`; B4 需库内存在 closed 任务否则记 FAIL)
 *   KANBAN_FULL_ONLY=p13   run only docs §13 Hotfix (HF1–HF3; 同次写入 PT3 与 §4 对齐)
 *   KANBAN_FULL_ONLY=p14   run only docs §14 覆盖率 (CV1–CV9; `runCoverageSection14` 含 G3-only 与 CV8 长流程)
 *   KANBAN_FULL_ONLY=p15   run only docs §15 测试失败补偿 (F1–F3; `runFailureCompensationSection15`; F2 与 G3/CV7 同路径)
 *   KANBAN_FULL_ONLY=p18   run only docs §18 边界与异常 (EX1–EX7; EX6 文档级手工场景记为豁免 PASS; EX7 走私有仓 GHA+ci-result 路径，同 §8 前置)
 *   KANBAN_E2E_GHA_SELF_HOSTED_TIMEOUT_MS  optional ms to wait for first GHA job on self-hosted (default 1200000 = 20 min)
 *   KANBAN_E2E_SKIP_RUNNER_LOCK=1       skip ~/.cache/kanban-e2e/selfhosted-runner.lock (§8 serializes on one org runner by default)
 *   §8 runPrivateCiFlow poll overrides (ms): KANBAN_E2E_POLL_IN_PROGRESS_MS (default 600000), KANBAN_E2E_POLL_LANE_MS (180000),
 *     KANBAN_E2E_POLL_REVIEW_MS (600000), KANBAN_E2E_POLL_REGRESSION_MS (900000) — raise regression/review when SCM merge is slow
 *   KANBAN_E2E_GHA_JOB_TIMEOUT_MINUTES     job timeout in generated kanban-e2e-selfhosted.yml (default 120, clamped 1–360; avoids runs stuck "in progress")
 */
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  ghCreateAndPush,
  projectBody,
  fetchJson,
  cdsPost,
  getFirstRunnerId,
  applyKanbanRunners,
  postProject,
  writeCase,
  pollTaskState,
  sqliteTableExists,
  ensureOutDir,
  resolveGhOwner,
} from './kanban-test-lib.mjs';
import {
  runAllIntegrationFlows,
  runA1A2A3,
  runA4Escalation,
  runA5RunnerStopped,
  runPreTestingSection,
  runTestingSection,
  runReviewSection,
  runPublicRegressionSection,
  runPrivateSelfHostSection,
  runUatFlow,
  runPendingReleaseSection,
  runPublicMergeHappyPath,
  runBlockedSection12,
  runHotfixSection13,
  runCoverageCv1to6,
  runCoverageSection14,
  runF3WrongStateFail,
  runFailureCompensationSection15,
  runBoundarySection18,
} from './kanban-test-flows.mjs';

const IM = process.env.AGENT_IM_BASE_URL || 'http://127.0.0.1:3300';
const CDS = process.env.CDS_BASE_URL || 'http://127.0.0.1:9223';
const RUN = `full-${Date.now()}`;
const OUT = ensureOutDir(RUN);

const tally = { pass: 0, fail: 0 };

function ok(id, pass, body) {
  writeCase(OUT, id, pass, body);
  if (pass) tally.pass += 1;
  else tally.fail += 1;
}

async function requireRunner() {
  const rid = await getFirstRunnerId(IM);
  if (!rid) throw new Error('No platform runner: configure CTI_RUNNERS / GET /api/platform/runners');
  return rid;
}

// ─── P0 / P1–P6 ───────────────────────────────────────────────────────────
async function runP_Prefix() {
  const h = await fetchJson(IM, '/health');
  let boardOk = false;
  try {
    const br = await fetch(`${IM}/board`);
    boardOk = br.ok;
  } catch {
    boardOk = false;
  }
  ok(
    'P1',
    h.ok && h.data?.ok === true && boardOk,
    h.ok && boardOk
      ? `GET /health ok=true; GET /board HTTP ok (no browser UI assertion).`
      : `${h.text?.slice(0, 200)} / boardHttpOk=${boardOk}`,
  );

  let g;
  try {
    g = ghCreateAndPush(`agent-im-p2-${RUN}`, 'Kanban P2 public');
  } catch (e) {
    for (const id of ['P2', 'P3', 'P4', 'P5', 'P6']) {
      ok(id, false, `gh repo create failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return null;
  }

  const pidP2 = `e2e-p2-${RUN}`;
  const pr = await postProject(
    IM,
    projectBody(pidP2, g.dir, g.remoteUrl, g.scmProject, { isPrivate: false }),
  );
  const p2Get = await fetchJson(IM, `/api/projects/${encodeURIComponent(pidP2)}`);
  ok(
    'P2',
    pr.ok && p2Get.ok && p2Get.data?.isPrivate === false,
    pr.ok && p2Get.ok
      ? `POST + GET /api/projects/${pidP2} isPrivate=false (Board 🔒 为手工目视).`
      : `${pr.text} / ${p2Get.text?.slice(0, 200)}`,
  );

  const pidP3 = `e2e-p3-${RUN}`;
  const pr3 = await postProject(
    IM,
    projectBody(pidP3, g.dir, g.remoteUrl, g.scmProject, { isPrivate: true }),
  );
  const p3Get = await fetchJson(IM, `/api/projects/${encodeURIComponent(pidP3)}`);
  ok(
    'P3',
    pr3.ok && p3Get.ok && p3Get.data?.isPrivate === true,
    pr3.ok && p3Get.ok
      ? `POST + GET /api/projects/${pidP3} isPrivate=true`
      : `${pr3.text} / ${p3Get.text?.slice(0, 200)}`,
  );

  const pidP4 = `e2e-p4-${RUN}`;
  const pr4 = await postProject(
    IM,
    projectBody(pidP4, g.dir, g.remoteUrl, g.scmProject, { requiresUat: true }),
  );
  ok('P4', pr4.ok, pr4.ok ? `Project with requiresUat=true created` : pr4.text);

  const pidP5 = `e2e-p5-${RUN}`;
  const pr5 = await postProject(IM, {
    ...projectBody(pidP5, g.dir, g.remoteUrl, g.scmProject),
    coverageCommand: 'npm run test:coverage',
  });
  ok('P5', pr5.ok && pr5.data?.coverageCommand === 'npm run test:coverage', pr5.ok ? `coverageCommand set` : pr5.text);

  try {
    execFileSync('git', ['-C', g.dir, 'fetch', 'origin'], { stdio: 'pipe' });
    ok('P6', true, `git fetch origin succeeded in ${g.dir}`);
  } catch (e) {
    ok('P6', false, e instanceof Error ? e.message : String(e));
  }

  return g;
}

/** docs/KANBAN-TESTCASES.md §1 — SP1, SP2, SP3 */
async function runSprintSectionOnly(runnerId) {
  const repo = `agent-im-sp-${RUN}`;
  let local;
  try {
    const x = ghCreateAndPush(repo, 'SP sprint');
    local = x.dir;
    const pid = `e2e-sp-${RUN}`;
    await postProject(IM, projectBody(pid, x.dir, x.remoteUrl, x.scmProject));
    await applyKanbanRunners(IM, pid, runnerId);
    const sprintName = `sprint-${RUN}`;
    const s1 = await fetchJson(IM, '/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, sprintName }),
    });
    ok('SP1', s1.ok && s1.data?.branchName, s1.ok ? `branch=${s1.data?.branchName}` : s1.text);
    const s2 = await fetchJson(IM, `/api/sprints?projectId=${encodeURIComponent(pid)}`);
    ok('SP2', s2.ok && Array.isArray(s2.data) && s2.data.length > 0, s2.ok ? `sprint list len=${s2.data.length}` : s2.text);
    const dup = await fetchJson(IM, '/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, sprintName }),
    });
    ok('SP3', !dup.ok && dup.status >= 400, !dup.ok ? `duplicate rejected HTTP ${dup.status}` : dup.text);
  } catch (e) {
    for (const id of ['SP1', 'SP2', 'SP3']) {
      ok(id, false, String(e));
    }
  } finally {
    if (local) {
      try {
        rmSync(local, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/** docs/KANBAN-TESTCASES.md §2 — T1, T2, T3（T4 为 Board 手工；见文档） */
async function runTodoSectionOnly(runnerId) {
  try {
    const tr = `agent-im-t-${RUN}`;
    const tg = ghCreateAndPush(tr, 'T tasks');
    const tpid = `e2e-t-${RUN}`;
    await postProject(IM, projectBody(tpid, tg.dir, tg.remoteUrl, tg.scmProject));
    await applyKanbanRunners(IM, tpid, runnerId);
    const ts = await fetchJson(IM, '/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: tpid, sprintName: `s-${RUN}` }),
    });
    const sprintId = ts.data?.id;
    const issue1 = `E2E-T1-${RUN}`;
    const c1 = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: tpid, sprintId, issueId: issue1, title: 't1' }),
    });
    ok('T1', c1.ok && c1.data?.workflowState === 'todo', c1.ok ? `workflowState=todo` : c1.text);
    const c2 = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: tpid,
        sprintId,
        issueId: `E2E-HF-${RUN}`,
        title: 'hf',
        isHotfix: true,
      }),
    });
    ok('T2', c2.ok && c2.data?.isHotfix === true, c2.ok ? `isHotfix=true` : c2.text);
    const c3 = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: tpid, sprintId, issueId: issue1, title: 'dup' }),
    });
    ok('T3', !c3.ok && c3.status >= 400, !c3.ok ? `dup rejected` : c3.text);

    rmSync(tg.dir, { recursive: true, force: true });
  } catch (e) {
    for (const id of ['T1', 'T2', 'T3']) {
      ok(id, false, String(e));
    }
  }
}

// ─── SP / T / CV / EX / F (reuse gh fixture) ──────────────────────────────
async function runSprintAndTasks(runnerId) {
  await runSprintSectionOnly(runnerId);
  await runTodoSectionOnly(runnerId);

  await runCoverageCv1to6({
    IM,
    RUN,
    ok,
    ghCreateAndPush,
    projectBody,
    postProject,
    fetchJson,
  });

  const ex1Repo = `agent-im-ex1-${RUN}`;
  try {
    const eg = ghCreateAndPush(ex1Repo, 'EX1');
    const epid = `e2e-ex1-${RUN}`;
    await postProject(IM, projectBody(epid, eg.dir, eg.remoteUrl, eg.scmProject));
    await applyKanbanRunners(IM, epid, runnerId);
    const sp = await fetchJson(IM, '/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: epid, sprintName: `s-${RUN}` }),
    });
    const cr = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: epid,
        sprintId: sp.data.id,
        issueId: `E2E-EX1-${RUN}`,
        title: 'ex1',
      }),
    });
    const cl = await fetchJson(IM, `/api/workflows/tasks/${cr.data.id}/close`, { method: 'POST' });
    ok('EX1', !cl.ok && cl.status >= 400, !cl.ok ? `close from todo rejected` : cl.text);
    rmSync(eg.dir, { recursive: true, force: true });
  } catch (e) {
    ok('EX1', false, e instanceof Error ? e.message : String(e));
  }

  const bad = await fetchJson(IM, '/api/workflows/tasks/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'ghost-project-xyz',
      sprintId: '00000000-0000-0000-0000-000000000001',
      issueId: 'X',
      title: 't',
    }),
  });
  ok('EX3', !bad.ok && bad.status >= 400, !bad.ok ? `ghost project rejected` : bad.text);

  const ex4Repo = `agent-im-ex4a-${RUN}`;
  const ex4bRepo = `agent-im-ex4b-${RUN}`;
  try {
    const ga = ghCreateAndPush(ex4Repo, 'EX4a');
    const gb = ghCreateAndPush(ex4bRepo, 'EX4b');
    const pa = `e2e-ex4a-${RUN}`;
    const pb = `e2e-ex4b-${RUN}`;
    await postProject(IM, projectBody(pa, ga.dir, ga.remoteUrl, ga.scmProject));
    await postProject(IM, projectBody(pb, gb.dir, gb.remoteUrl, gb.scmProject));
    const sb = await fetchJson(IM, '/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pb, sprintName: `sb-${RUN}` }),
    });
    const wrongSprint = sb.data.id;
    const sa = await fetchJson(IM, '/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pa, sprintName: `sa-${RUN}` }),
    });
    const ex4 = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pa,
        sprintId: wrongSprint,
        issueId: `E2E-EX4-${RUN}`,
        title: 'x',
      }),
    });
    ok('EX4', !ex4.ok && ex4.status >= 400, !ex4.ok ? ex4.text.slice(0, 400) : 'expected error');
    rmSync(ga.dir, { recursive: true, force: true });
    rmSync(gb.dir, { recursive: true, force: true });
  } catch (e) {
    ok('EX4', false, e instanceof Error ? e.message : String(e));
  }

  const mig = sqliteTableExists('project_coverage_history');
  ok(
    'EX5',
    mig.ok,
    mig.ok
      ? `SQLite table project_coverage_history exists in platform DB.`
      : `Could not verify migration table: ${mig.detail} (set CTI_KANBAN_PLATFORM_DIR to agent-im data dir, or rely on GET /coverage/history passing in CV5).`,
  );

  await runF3WrongStateFail({
    IM,
    RUN,
    runnerId,
    ok,
    ghCreateAndPush,
    projectBody,
    postProject,
    applyKanbanRunners,
    fetchJson,
  });

  try {
    const a = await fetchJson(IM, '/health');
    const b = await fetchJson(IM, '/health');
    ok('EX2', a.ok && b.ok, `Issued two concurrent /health requests; both ok=${a.ok && b.ok}.`);
  } catch (e) {
    ok('EX2', false, String(e));
  }
}

/** docs/KANBAN-TESTCASES.md §3 — A1–A5 (same as `node scripts/kanban-a-only.mjs`). */
async function runInProgressSectionOnly(runnerId) {
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
    cdsPost,
  };
  await runA1A2A3(ctx);
  await runA4Escalation(ctx);
  await runA5RunnerStopped(ctx);
}

// ─── A / B / R4 / G5 / SH5 / HF / agent-only placeholders ─────────────────
async function runABRGHF(runnerId) {
  const repo = `agent-im-ab-${RUN}`;
  try {
    const g = ghCreateAndPush(repo, 'AB');
    const pid = `e2e-ab-${RUN}`;
    await postProject(IM, projectBody(pid, g.dir, g.remoteUrl, g.scmProject));
    await applyKanbanRunners(IM, pid, runnerId);
    const sp = await fetchJson(IM, '/api/workflows/sprints/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: pid, sprintName: `s-${RUN}` }),
    });
    const t1 = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `E2E-DEP-${RUN}`,
        title: 'dep',
      }),
    });
    const t2 = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `E2E-MAIN-${RUN}`,
        title: 'main',
        dependsOnIssueIds: [`E2E-DEP-${RUN}`],
      }),
    });
    const as = await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `E2E-MAIN-${RUN}`,
        taskSessionId: t2.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'handoff for dependency test',
      }),
    });
    const st = as.data?.workflowState;
    ok(
      'A3',
      st === 'pending_start',
      `Task with unfinished dependency queued as pending_start (state=${st}). Doc "报错" is primarily UI; API queues.`,
    );

    const ta = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `E2E-A1-${RUN}`,
        title: 'a1',
      }),
    });
    const asn = await fetchJson(IM, '/api/workflows/tasks/assign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `E2E-A1-${RUN}`,
        taskSessionId: ta.data.id,
        kanbanAgent: 'agent-dev',
        handoffComment: 'A1 handoff for automation',
      }),
    });
    const poll = await pollTaskState(IM, ta.data.id, 'in_progress|pending_start', 180000);
    ok(
      'A1',
      poll.ok && (poll.state === 'in_progress' || poll.state === 'pending_start'),
      `assign issued; state=${poll.state} (in_progress expected after queue materialize).`,
    );

    await runBlockedSection12(
      {
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
      },
      { pid, sprintId: sp.data.id },
    );

    try {
      const rvRepo = `agent-im-rv-${RUN}`;
      const rg = ghCreateAndPush(rvRepo, 'R4');
      const rpid = `e2e-rv-${RUN}`;
      await postProject(IM, projectBody(rpid, rg.dir, rg.remoteUrl, rg.scmProject));
      await applyKanbanRunners(IM, rpid, runnerId);
      const rs = await fetchJson(IM, '/api/workflows/sprints/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: rpid, sprintName: `s-${RUN}` }),
      });
      const rt = await fetchJson(IM, '/api/workflows/tasks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: rpid,
          sprintId: rs.data.id,
          issueId: `E2E-R4-${RUN}`,
          title: 'r4',
        }),
      });
      await fetchJson(IM, '/api/workflows/tasks/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: rpid,
          sprintId: rs.data.id,
          issueId: `E2E-R4-${RUN}`,
          taskSessionId: rt.data.id,
          kanbanAgent: 'agent-dev',
          handoffComment: 'r4',
        }),
      });
      await pollTaskState(IM, rt.data.id, 'in_progress', 180000);
      const tw = await fetchJson(IM, `/api/tasks/${encodeURIComponent(rt.data.id)}`);
      const workDir = tw.data?.worktreePath || rg.dir;
      execSync(
        `bash -c 'echo r4 > "${workDir}/r4-e2e.txt" && git -C "${workDir}" add r4-e2e.txt && git -C "${workDir}" commit -m "r4 e2e"'`,
        { stdio: 'pipe' },
      );
      await fetchJson(IM, `/api/workflows/tasks/${rt.data.id}/start-testing`, { method: 'POST' });
      await pollTaskState(IM, rt.data.id, 'pre_testing', 120000);
      await fetchJson(IM, `/api/workflows/tasks/${rt.data.id}/start-feature-testing`, { method: 'POST' });
      await pollTaskState(IM, rt.data.id, 'testing', 120000);
      await fetchJson(IM, `/api/workflows/tasks/${rt.data.id}/submit-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitMessage: 'rv', prTitle: 'rv', prBody: 'rv' }),
      });
      await pollTaskState(IM, rt.data.id, 'review', 180000);
      const rj = await fetchJson(IM, `/api/workflows/tasks/${rt.data.id}/reject-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: '' }),
      });
      ok('R4', !rj.ok && rj.status >= 400, !rj.ok ? `empty reject comment rejected` : rj.text);
      rmSync(rg.dir, { recursive: true, force: true });
    } catch (e) {
      ok('R4', false, e instanceof Error ? e.message : String(e));
    }

    const g5t = await fetchJson(IM, '/api/workflows/tasks/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: pid,
        sprintId: sp.data.id,
        issueId: `E2E-G5-${RUN}`,
        title: 'g5',
      }),
    });
    const g5 = await fetchJson(IM, `/api/workflows/tasks/${g5t.data.id}/regression/refresh`, { method: 'POST' });
    ok('G5', !g5.ok && g5.status >= 400, !g5.ok ? g5.text.slice(0, 400) : 'expected failure');

    const sh5 = await fetchJson(IM, `/api/workflows/tasks/${g5t.data.id}/ci-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'success' }),
    });
    ok('SH5', !sh5.ok && sh5.status >= 400, !sh5.ok ? `ci-result rejected in wrong state` : sh5.text);

    rmSync(g.dir, { recursive: true, force: true });
  } catch (e) {
    for (const id of ['A1', 'A3', 'B1', 'B2', 'B3', 'B4', 'R4', 'G5', 'SH5']) {
      ok(id, false, String(e));
    }
  }

  await runHotfixSection13({
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
  });

  await runAllIntegrationFlows({
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
  });
}

function writeReadme(extraLine) {
  const readme = [
    `# Kanban full test run (${RUN})`,
    ``,
    `Source: docs/KANBAN-TESTCASES.md`,
    extraLine ? `${extraLine}` : null,
    ``,
    `Server: ${IM}`,
    `CDS_BASE_URL (optional, for scripts that still pass cdsPost in ctx): ${CDS}`,
    `GitHub owner/org: ${resolveGhOwner()}`,
    ``,
    `PASS: ${tally.pass}`,
    `FAIL: ${tally.fail}`,
    ``,
    `Integration flows (scripts/kanban-test-flows.mjs) drive gh-backed repos, merges, and workflow APIs; see per-case .md files for details.`,
    ``,
    `Results per case: this directory.`,
  ]
    .filter(Boolean)
    .join('\n');
  writeFileSync(join(OUT, 'README.md'), readme, 'utf8');
}

async function main() {
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'pipe' });
  } catch {
    console.error('gh auth status failed. Run: gh auth login');
    process.exit(1);
  }

  const only = process.env.KANBAN_FULL_ONLY?.trim().toLowerCase();
  if (only === 'p0' || only === 'section0' || only === '§0') {
    const g0 = await runP_Prefix();
    if (g0) {
      try {
        rmSync(g0.dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    writeReadme('Scope: §0 前置条件 only (`KANBAN_FULL_ONLY=p0`).');
    console.log(`Done (§0 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p1' || only === 'section1' || only === '§1' || only === 'sp') {
    const runnerId = await requireRunner();
    await runSprintSectionOnly(runnerId);
    writeReadme('Scope: §1 Sprint only (`KANBAN_FULL_ONLY=p1`).');
    console.log(`Done (§1 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p2' || only === 'section2' || only === '§2' || only === 'todo') {
    const runnerId = await requireRunner();
    await runTodoSectionOnly(runnerId);
    writeReadme('Scope: §2 创建任务 todo only (`KANBAN_FULL_ONLY=p2`).');
    console.log(`Done (§2 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p3' || only === 'section3' || only === '§3' || only === 'in_progress') {
    const runnerId = await requireRunner();
    await runInProgressSectionOnly(runnerId);
    writeReadme('Scope: §3 开发 in_progress only (`KANBAN_FULL_ONLY=p3`).');
    console.log(`Done (§3 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p4' || only === 'section4' || only === '§4' || only === 'pre_testing') {
    const runnerId = await requireRunner();
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
      cdsPost,
    };
    await runPreTestingSection(ctx);
    writeReadme('Scope: §4 预测试 pre_testing only (`KANBAN_FULL_ONLY=p4`).');
    console.log(`Done (§4 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p5' || only === 'section5' || only === '§5' || only === 'testing') {
    const runnerId = await requireRunner();
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
      cdsPost,
    };
    await runTestingSection(ctx);
    writeReadme('Scope: §5 功能测试 testing only (`KANBAN_FULL_ONLY=p5`).');
    console.log(`Done (§5 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p6' || only === 'section6' || only === '§6' || only === 'review') {
    const runnerId = await requireRunner();
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
      cdsPost,
    };
    await runReviewSection(ctx);
    writeReadme('Scope: §6 评审 review only (`KANBAN_FULL_ONLY=p6`).');
    console.log(`Done (§6 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p7' || only === 'section7' || only === '§7' || only === 'regression_public') {
    const runnerId = await requireRunner();
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
      cdsPost,
    };
    await runPublicRegressionSection(ctx);
    writeReadme('Scope: §7 回归 regression_testing（公开仓库）only (`KANBAN_FULL_ONLY=p7`).');
    console.log(`Done (§7 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p8' || only === 'section8' || only === '§8' || only === 'self_host' || only === 'private_regression') {
    const runnerId = await requireRunner();
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
      cdsPost,
    };
    await runPrivateSelfHostSection(ctx);
    writeReadme('Scope: §8 回归 私有仓 self-host-runner only (`KANBAN_FULL_ONLY=p8`).');
    console.log(`Done (§8 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p9' || only === 'section9' || only === '§9' || only === 'uat') {
    const runnerId = await requireRunner();
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
    };
    await runUatFlow(ctx);
    writeReadme('Scope: §9 UAT pending_uat (U1–U3) only (`KANBAN_FULL_ONLY=p9`).');
    console.log(`Done (§9 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p10' || only === 'section10' || only === '§10' || only === 'pending_release') {
    const runnerId = await requireRunner();
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
      cdsPost,
    };
    await runPendingReleaseSection(ctx);
    writeReadme('Scope: §10 待发布 pending_release (PR1–PR3) (`KANBAN_FULL_ONLY=p10`; PR1/PR2 经 FULL-16 路径，结果目录含同路径 CL/FULL-16 ID).');
    console.log(`Done (§10 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p11' || only === 'section11' || only === '§11' || only === 'close' || only === 'close_section') {
    const runnerId = await requireRunner();
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
      cdsPost,
    };
    await runPublicMergeHappyPath(ctx);
    writeReadme(
      'Scope: §11 关单 close / close-async (CL1–CL7; CL1a≈PR2+close-async+CL7) via `runPublicMergeHappyPath` (`KANBAN_FULL_ONLY=p11`; 含达 pending_release 的前置步骤，同 FULL-16 用例 ID).',
    );
    console.log(`Done (§11 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p12' || only === 'section12' || only === '§12' || only === 'blocked') {
    const runnerId = await requireRunner();
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
    };
    await runBlockedSection12(ctx);
    writeReadme('Scope: §12 阻塞 blocked (B1–B4) (`KANBAN_FULL_ONLY=p12`; B4 依赖平台已有 `closed` 任务).');
    console.log(`Done (§12 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p13' || only === 'section13' || only === '§13' || only === 'hotfix') {
    const runnerId = await requireRunner();
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
    };
    await runHotfixSection13(ctx);
    writeReadme('Scope: §13 Hotfix (HF1–HF3; PT3 与 HF2 同断言，`KANBAN_FULL_ONLY=p13`).');
    console.log(`Done (§13 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p14' || only === 'section14' || only === '§14' || only === 'coverage') {
    const runnerId = await requireRunner();
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
    };
    await runCoverageSection14(ctx);
    writeReadme('Scope: §14 覆盖率管理 (CV1–CV9) (`KANBAN_FULL_ONLY=p14`; CV7 绑定 G3 回归失败路径).');
    console.log(`Done (§14 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p15' || only === 'section15' || only === '§15' || only === 'failure-compensation') {
    const runnerId = await requireRunner();
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
    };
    await runFailureCompensationSection15(ctx);
    writeReadme('Scope: §15 测试失败补偿 (F1–F3; F2/G3/CV7 同路径) (`KANBAN_FULL_ONLY=p15`).');
    console.log(`Done (§15 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  if (only === 'p18' || only === 'section18' || only === '§18' || only === 'boundary') {
    const runnerId = await requireRunner();
    await runBoundarySection18({
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
    });
    writeReadme(
      'Scope: §18 边界与异常 EX1–EX7 (`KANBAN_FULL_ONLY=p18`; EX6 为占位; EX7 需 org 私有仓+self-hosted GHA，与 §8 相同环境).',
    );
    console.log(`Done (§18 only). PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
    const strict = process.env.KANBAN_FULL_STRICT === '1';
    process.exit(strict && tally.fail > 0 ? 1 : 0);
    return;
  }

  const runnerId = await requireRunner();

  const g0 = await runP_Prefix();
  if (g0) {
    try {
      rmSync(g0.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  await runSprintAndTasks(runnerId);
  await runABRGHF(runnerId);

  writeReadme(null);

  console.log(`Done. PASS=${tally.pass} FAIL=${tally.fail} → ${OUT}/`);
  const strict = process.env.KANBAN_FULL_STRICT === '1';
  process.exit(strict && tally.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
