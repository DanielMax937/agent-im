import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSlaveReportSessionContextBlock,
  resolveSlaveReportGoal,
  resolveSlaveReportGoalWithFallbacks,
  sanitizeSessionSummaryForDisplay,
  SLAVE_REPORT_GOAL_MISSING,
  SLAVE_REPORT_GOAL_MISSING_ASSISTANT_BODY,
  truncateMasterEvaluationsForRollingDisplay,
} from '../lib/bridge/slave-report-goal';

describe('resolveSlaveReportGoal / resolveSlaveReportGoalWithFallbacks', () => {
  let prevGoal: string | undefined;

  beforeEach(() => {
    prevGoal = process.env.CTI_SLAVE_REPORT_GOAL;
    delete process.env.CTI_SLAVE_REPORT_GOAL;
  });

  afterEach(() => {
    if (prevGoal === undefined) delete process.env.CTI_SLAVE_REPORT_GOAL;
    else process.env.CTI_SLAVE_REPORT_GOAL = prevGoal;
  });

  it('uses the last User goal block when multiple exist', () => {
    const s = 'User goal: 告诉我绍兴天气\n---\nUser goal: 进入到目录 /repo 改造 Kanban';
    assert.equal(resolveSlaveReportGoal(s), '进入到目录 /repo 改造 Kanban');
  });

  it('respects CTI_SLAVE_REPORT_GOAL override', () => {
    process.env.CTI_SLAVE_REPORT_GOAL = 'Jira Kanban 改造（Claude-to-IM-skill）';
    assert.equal(resolveSlaveReportGoal('User goal: stale'), 'Jira Kanban 改造（Claude-to-IM-skill）');
  });

  it('returns SLAVE_REPORT_GOAL_MISSING when summary is empty and no last user', () => {
    assert.equal(resolveSlaveReportGoal(null), SLAVE_REPORT_GOAL_MISSING);
  });

  it('falls back to lastUserRequest when summary has no User goal marker', () => {
    const g = resolveSlaveReportGoalWithFallbacks({
      sessionSummary: 'Master evaluation: ok',
      lastUserRequest: 'Fix the Kanban board',
    });
    assert.equal(g, 'Fix the Kanban board');
  });

  it('prefers User goal in summary over lastUserRequest', () => {
    const g = resolveSlaveReportGoalWithFallbacks({
      sessionSummary: 'User goal: From summary',
      lastUserRequest: 'From redis',
    });
    assert.equal(g, 'From summary');
  });

  it('ignores legacy "(unknown — see session context)" embedded in summary and uses lastUserRequest', () => {
    const g = resolveSlaveReportGoalWithFallbacks({
      sessionSummary: 'User goal: (unknown — see session context)\n---\nMaster evaluation: ok',
      lastUserRequest: 'Real task from Telegram',
    });
    assert.equal(g, 'Real task from Telegram');
  });

  it('falls through to SLAVE_REPORT_GOAL_MISSING when summary only has legacy unknown and no last user', () => {
    const g = resolveSlaveReportGoalWithFallbacks({
      sessionSummary: 'User goal: (unknown — see session context)',
      lastUserRequest: null,
    });
    assert.equal(g, SLAVE_REPORT_GOAL_MISSING);
  });
});

describe('SLAVE_REPORT_GOAL_MISSING_ASSISTANT_BODY', () => {
  it('is non-empty and guides Master to paste requirements / check bridge', () => {
    assert.ok(SLAVE_REPORT_GOAL_MISSING_ASSISTANT_BODY.length > 80);
    assert.ok(SLAVE_REPORT_GOAL_MISSING_ASSISTANT_BODY.includes('last_user'));
    assert.ok(SLAVE_REPORT_GOAL_MISSING_ASSISTANT_BODY.includes('粘贴完整需求'));
  });
});

describe('sanitizeSessionSummaryForDisplay', () => {
  it('removes legacy User goal unknown lines but keeps real content', () => {
    const out = sanitizeSessionSummaryForDisplay(
      'User goal: (unknown — see session context)\n---\nMaster evaluation: ok',
    );
    assert.ok(!out.includes('unknown — see session context'));
    assert.ok(out.includes('Master evaluation'));
  });
});

describe('truncateMasterEvaluationsForRollingDisplay', () => {
  let prevKeep: string | undefined;

  beforeEach(() => {
    prevKeep = process.env.CTI_SLAVE_REPORT_MASTER_EVAL_KEEP_LAST;
    delete process.env.CTI_SLAVE_REPORT_MASTER_EVAL_KEEP_LAST;
  });

  afterEach(() => {
    if (prevKeep === undefined) delete process.env.CTI_SLAVE_REPORT_MASTER_EVAL_KEEP_LAST;
    else process.env.CTI_SLAVE_REPORT_MASTER_EVAL_KEEP_LAST = prevKeep;
  });

  it('keeps only the last N Master evaluation segments and inserts an omission note', () => {
    const s =
      'User goal: task\n---\nMaster evaluation: old verdict\n---\nMaster evaluation: mid\n---\nMaster evaluation: latest';
    const out = truncateMasterEvaluationsForRollingDisplay(s, 2);
    assert.ok(!out.includes('old verdict'));
    assert.ok(out.includes('mid'));
    assert.ok(out.includes('latest'));
    assert.ok(out.includes('已省略'));
    assert.ok(out.includes('仅保留最近 2 轮'));
  });

  it('override keepLast=0 disables truncation', () => {
    const s =
      'Master evaluation: a\n---\nMaster evaluation: b\n---\nMaster evaluation: c';
    const out = truncateMasterEvaluationsForRollingDisplay(s, 0);
    assert.equal(out, s);
  });

  it('does not drop when count is within limit', () => {
    const s = 'User goal: x\n---\nMaster evaluation: one';
    assert.equal(truncateMasterEvaluationsForRollingDisplay(s, 2), s);
    assert.equal(truncateMasterEvaluationsForRollingDisplay(s), s);
  });

  it('defaults to keep last 1 round when env unset (matches CTI_SLAVE_REPORT_MASTER_EVAL_KEEP_LAST default)', () => {
    const s =
      'User goal: task\n---\nMaster evaluation: old verdict\n---\nMaster evaluation: latest';
    const out = truncateMasterEvaluationsForRollingDisplay(s);
    assert.ok(!out.includes('old verdict'));
    assert.ok(out.includes('latest'));
    assert.ok(out.includes('仅保留最近 1 轮'));
  });

  it('invalid CTI_SLAVE_REPORT_MASTER_EVAL_KEEP_LAST falls back to default 1', () => {
    process.env.CTI_SLAVE_REPORT_MASTER_EVAL_KEEP_LAST = 'not-a-number';
    const s = 'Master evaluation: a\n---\nMaster evaluation: b';
    const out = truncateMasterEvaluationsForRollingDisplay(s);
    assert.ok(!out.includes('Master evaluation: a'));
    assert.ok(out.includes('b'));
  });

  it('still truncates when User goal sits between Master evaluation rounds (not only --- splits)', () => {
    const s =
      'Master evaluation: stale Hello mismatch\n---\nUser goal: Kanban\n---\nMaster evaluation: latest ok';
    const out = truncateMasterEvaluationsForRollingDisplay(s, 1);
    assert.ok(!out.includes('stale Hello mismatch'));
    assert.ok(out.includes('latest ok'));
    assert.ok(out.includes('User goal: Kanban'));
  });

  it('does not split one verdict when Master evaluation body contains --- lines (matches afterAutoModeMasterTurn slices)', () => {
    const s =
      'User goal: u\n---\nMaster evaluation: **ok**\n---\nmarkdown rule line\n---\nMaster evaluation: latest verdict';
    const out = truncateMasterEvaluationsForRollingDisplay(s, 1);
    assert.ok(!out.includes('**ok**'));
    assert.ok(!out.includes('markdown rule line'));
    assert.ok(out.includes('latest verdict'));
    assert.ok(out.includes('User goal: u'));
  });
});

describe('buildSlaveReportSessionContextBlock', () => {
  it('prepends canonical goal so history does not read as the active title', () => {
    const summary = 'User goal: 告诉我深圳天气\n---\nUser goal: Jira Kanban 改造';
    const canonical = 'Jira Kanban 改造';
    const block = buildSlaveReportSessionContextBlock(summary, canonical);
    assert.ok(block.startsWith('### Session context (rolling history)'));
    assert.ok(block.includes('**Canonical goal (same as report header above):** Jira Kanban 改造'));
    assert.ok(block.includes('告诉我深圳天气'));
    assert.ok(block.includes('CTI_SLAVE_REPORT_MASTER_EVAL_KEEP_LAST'));
  });

  it('when history is only stripped placeholders, still shows canonical and a reset hint', () => {
    const block = buildSlaveReportSessionContextBlock(
      'User goal: (unknown — see session context)',
      SLAVE_REPORT_GOAL_MISSING,
    );
    assert.ok(block.includes(SLAVE_REPORT_GOAL_MISSING));
    assert.ok(block.includes('Auto mode reset') || block.includes('Telegram'));
    assert.ok(!block.includes('User goal: (unknown'));
  });

  it('returns empty string when summary is null', () => {
    assert.equal(buildSlaveReportSessionContextBlock(null, 'x'), '');
  });
});
