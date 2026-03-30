import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  appendKanbanRequirementGIfMissing,
  KANBAN_REDIS_REQUIREMENT_G_MARKER,
  truncateRollingSessionSummary,
  truncateSessionSummaryAfterGIfNeeded,
} from '../lib/bridge/kanban-redis-supplement';

describe('appendKanbanRequirementGIfMissing', () => {
  let prev: string | undefined;
  let prevMax: string | undefined;

  beforeEach(() => {
    prev = process.env.CTI_KANBAN_SUPPLEMENT_G_IN_REDIS;
    prevMax = process.env.CTI_KANBAN_SESSION_SUMMARY_MAX;
    delete process.env.CTI_KANBAN_SUPPLEMENT_G_IN_REDIS;
    delete process.env.CTI_KANBAN_SESSION_SUMMARY_MAX;
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.CTI_KANBAN_SUPPLEMENT_G_IN_REDIS;
    else process.env.CTI_KANBAN_SUPPLEMENT_G_IN_REDIS = prev;
    if (prevMax === undefined) delete process.env.CTI_KANBAN_SESSION_SUMMARY_MAX;
    else process.env.CTI_KANBAN_SESSION_SUMMARY_MAX = prevMax;
  });

  it('appends marker and body when missing', () => {
    const out = appendKanbanRequirementGIfMissing('User goal: hello');
    assert.ok(out.includes(KANBAN_REDIS_REQUIREMENT_G_MARKER));
    assert.ok(out.includes('worktree'));
    assert.ok(out.includes('refreshRegressionIfMasterAdvanced'));
  });

  it('does not duplicate when marker already present', () => {
    const once = appendKanbanRequirementGIfMissing('User goal: x');
    const twice = appendKanbanRequirementGIfMissing(once);
    assert.equal(twice, once);
  });

  it('respects CTI_KANBAN_SUPPLEMENT_G_IN_REDIS=0', () => {
    process.env.CTI_KANBAN_SUPPLEMENT_G_IN_REDIS = '0';
    assert.equal(appendKanbanRequirementGIfMissing('User goal: x'), 'User goal: x');
  });

  it('truncates rolling base before appending g so the supplement is never tail-cut', () => {
    const pad = 'x'.repeat(3000);
    const base = `${pad}\n---\nUser goal: short`;
    const trimmed = truncateRollingSessionSummary(base);
    assert.ok(trimmed.length <= 2000);
    const withG = appendKanbanRequirementGIfMissing(trimmed);
    assert.ok(withG.includes(KANBAN_REDIS_REQUIREMENT_G_MARKER));
    assert.ok(withG.includes('refreshRegressionIfMasterAdvanced'));
    assert.ok(withG.includes('重新拉取'));
    assert.ok(withG.includes('User goal: short'));
  });

  it('truncateSessionSummaryAfterGIfNeeded keeps the full g block when total exceeds hard max', () => {
    process.env.CTI_KANBAN_SESSION_SUMMARY_MAX = '1200';
    const longPrefix = 'z'.repeat(1800);
    const withG = appendKanbanRequirementGIfMissing(`User goal: tail\n---\n${longPrefix}`);
    assert.ok(withG.length > 1200);
    const out = truncateSessionSummaryAfterGIfNeeded(withG);
    assert.ok(out.length <= 1200);
    assert.ok(out.includes(KANBAN_REDIS_REQUIREMENT_G_MARKER));
    assert.ok(out.includes('refreshRegressionIfMasterAdvanced'));
    assert.ok(out.includes('重新拉取'));
  });
});
