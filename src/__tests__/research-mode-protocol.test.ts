import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isMutualCompletion,
  parseResearcherStatus,
  parseReviewerVerdict,
  researcherFeedbackKindForVerdict,
  reviewerPromptKindForPhase,
  RESEARCH_A_STATUS_PREFIX,
  RESEARCH_B_VERDICT_PREFIX,
  stripProtocolMarkers,
} from '../lib/bridge/research-mode/protocol';

describe('parseResearcherStatus', () => {
  it('parses a valid plan status emitted at the end of a reply', () => {
    const reply = [
      'Here is the plan:',
      '1. Read goal.md',
      '2. Refactor authReducer',
      '',
      `${RESEARCH_A_STATUS_PREFIX} {"phase": "plan", "summary": "refactor authReducer", "next": "awaiting reviewer"}`,
    ].join('\n');
    const parsed = parseResearcherStatus(reply);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.status, {
      phase: 'plan',
      summary: 'refactor authReducer',
      next: 'awaiting reviewer',
    });
  });

  it('picks the LAST tagged line when the agent emits more than one', () => {
    const reply = [
      `${RESEARCH_A_STATUS_PREFIX} {"phase": "plan", "summary": "old", "next": "n/a"}`,
      'oops, I changed my mind:',
      `${RESEARCH_A_STATUS_PREFIX} {"phase": "complete", "summary": "done", "next": "awaiting sign-off"}`,
    ].join('\n');
    const parsed = parseResearcherStatus(reply);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.status?.phase, 'complete');
  });

  it('reports missing-tagged-json when the protocol line is absent', () => {
    const parsed = parseResearcherStatus('hello world without any marker');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error, 'missing-tagged-json');
    assert.equal(parsed.status, null);
  });

  it('reports invalid-json when the payload is malformed', () => {
    const reply = `${RESEARCH_A_STATUS_PREFIX} {phase: "plan"}`;
    const parsed = parseResearcherStatus(reply);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? '', /invalid-json/);
  });

  it('rejects unknown phase values', () => {
    const reply = `${RESEARCH_A_STATUS_PREFIX} {"phase": "bogus", "summary": "x", "next": "y"}`;
    const parsed = parseResearcherStatus(reply);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? '', /invalid-phase/);
  });
});

describe('parseReviewerVerdict', () => {
  it('parses a confirm-complete verdict', () => {
    const reply = [
      'Looks great.',
      `${RESEARCH_B_VERDICT_PREFIX} {"verdict": "confirm-complete", "advice": "verified vitest output 5/5 green"}`,
    ].join('\n');
    const parsed = parseReviewerVerdict(reply);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.evaluation?.verdict, 'confirm-complete');
  });

  it('rejects unknown verdict tokens', () => {
    const reply = `${RESEARCH_B_VERDICT_PREFIX} {"verdict": "approve_plan", "advice": "..."}`;
    const parsed = parseReviewerVerdict(reply);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error ?? '', /invalid-verdict/);
  });
});

describe('stripProtocolMarkers', () => {
  it('removes both tagged lines and trailing code fences', () => {
    const text = [
      'My plan:',
      '- step one',
      '',
      '```',
      `${RESEARCH_A_STATUS_PREFIX} {"phase": "plan", "summary": "", "next": ""}`,
      '```',
    ].join('\n');
    const out = stripProtocolMarkers(text);
    assert.equal(out, 'My plan:\n- step one');
  });

  it('returns empty string for empty input', () => {
    assert.equal(stripProtocolMarkers(''), '');
  });
});

describe('isMutualCompletion', () => {
  it('is true only when A=complete and B=confirm-complete', () => {
    assert.equal(
      isMutualCompletion(
        { phase: 'complete', summary: '', next: '' },
        { verdict: 'confirm-complete', advice: '' },
      ),
      true,
    );
    assert.equal(
      isMutualCompletion(
        { phase: 'complete', summary: '', next: '' },
        { verdict: 'reject-complete', advice: '' },
      ),
      false,
    );
    assert.equal(
      isMutualCompletion(
        { phase: 'plan', summary: '', next: '' },
        { verdict: 'confirm-complete', advice: '' },
      ),
      false,
    );
  });
});

describe('reviewerPromptKindForPhase / researcherFeedbackKindForVerdict', () => {
  it('routes phases to review templates', () => {
    assert.equal(reviewerPromptKindForPhase('plan'), 'plan');
    assert.equal(reviewerPromptKindForPhase('blocker'), 'blocker');
    assert.equal(reviewerPromptKindForPhase('complete'), 'completion');
  });

  it('routes verdicts to feedback templates', () => {
    assert.equal(researcherFeedbackKindForVerdict('approve-plan'), 'plan');
    assert.equal(researcherFeedbackKindForVerdict('request-changes'), 'plan');
    assert.equal(researcherFeedbackKindForVerdict('suggest-direction'), 'blocker');
    assert.equal(researcherFeedbackKindForVerdict('confirm-complete'), 'completion');
    assert.equal(researcherFeedbackKindForVerdict('reject-complete'), 'completion');
  });
});
