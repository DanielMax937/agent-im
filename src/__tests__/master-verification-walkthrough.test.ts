import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  MASTER_VERIFICATION_WALKTHROUGH_PREFIX,
  buildMasterVerificationWalkthroughPrompt,
  inferMasterVerificationMode,
  parseMasterReviewDecision,
  parseVerificationOutcome,
} from '../lib/bridge/master-verification-walkthrough';

describe('master-verification-walkthrough', () => {
  it('parseVerificationOutcome detects PASSED and FAILED', () => {
    assert.strictEqual(
      parseVerificationOutcome('ok\nVERIFICATION_OUTCOME: PASSED\n'),
      'passed',
    );
    assert.strictEqual(
      parseVerificationOutcome('broken\nVERIFICATION_OUTCOME: FAILED\n'),
      'failed',
    );
    assert.strictEqual(parseVerificationOutcome('no marker'), 'unknown');
  });

  it('parseVerificationOutcome prefers tagged JSON when present', () => {
    assert.strictEqual(
      parseVerificationOutcome('done\nVERIFICATION_RESULT_JSON: {"pass": true}\n'),
      'passed',
    );
    assert.strictEqual(
      parseVerificationOutcome('bad\nVERIFICATION_RESULT_JSON: {"pass":"false"}\n'),
      'failed',
    );
  });

  it('parseMasterReviewDecision prefers tagged JSON and avoids false follow-up on negative wording', () => {
    assert.strictEqual(
      parseMasterReviewDecision('summary\nREVIEW_RESULT_JSON: {"pass": true}\nneeds improvement: no'),
      'pass',
    );
    assert.strictEqual(
      parseMasterReviewDecision('please fix this\nREVIEW_RESULT_JSON: {"pass":"false"}'),
      'follow_up',
    );
  });

  it('parseMasterReviewDecision accepts fail JSON with reason field', () => {
    assert.strictEqual(
      parseMasterReviewDecision('please fix this\nREVIEW_RESULT_JSON: {"pass": false, "reason": "missing live verification"}'),
      'follow_up',
    );
  });

  it('parseMasterReviewDecision falls back when tagged JSON is malformed', () => {
    assert.strictEqual(
      parseMasterReviewDecision('任务已满足目标，可结案。\nREVIEW_RESULT_JSON: {"pass": tru}'),
      'pass',
    );
    assert.strictEqual(
      parseMasterReviewDecision('needs improvement\nREVIEW_RESULT_JSON: {"pass": fals}'),
      'follow_up',
    );
  });

  it('parseMasterReviewDecision treats explicit finish markers as pass without JSON', () => {
    assert.strictEqual(
      parseMasterReviewDecision('**结论：可以结案**（不要写 “needs improvement”）。'),
      'pass',
    );
    assert.strictEqual(
      parseMasterReviewDecision('**可以结案**（无需再打回，回复里不要出现 “needs improvement”）。'),
      'pass',
    );
    assert.strictEqual(
      parseMasterReviewDecision('从助手工作 needs improvement：否。任务可结案。'),
      'pass',
    );
    assert.strictEqual(
      parseMasterReviewDecision('任务已满足目标，无需再派工。'),
      'pass',
    );
  });

  it('buildMasterVerificationWalkthroughPrompt includes prefix and session tail', () => {
    const summary = 'x'.repeat(4000);
    const p = buildMasterVerificationWalkthroughPrompt(summary);
    assert.ok(p.startsWith(MASTER_VERIFICATION_WALKTHROUGH_PREFIX));
    assert.ok(p.includes('x'.repeat(100)));
    assert.ok(p.includes('If verification fails'));
    assert.ok(p.includes('VERIFICATION_ACTION: API_ONLY'));
  });

  it('buildMasterVerificationWalkthroughPrompt adds re-verification block when isReverify', () => {
    const p = buildMasterVerificationWalkthroughPrompt('ctx', { isReverify: true });
    assert.ok(p.includes('Re-verification'));
    assert.ok(p.includes('Loop until clean'));
  });

  it('inferMasterVerificationMode keeps non-UI info tasks on api_only', () => {
    const mode = inferMasterVerificationMode(
      'User goal: tell me current IP information\nMaster evaluation: verify local network data and curl output',
    );
    assert.strictEqual(mode, 'api_only');
  });

  it('inferMasterVerificationMode upgrades UI tasks to ui_and_api', () => {
    const mode = inferMasterVerificationMode(
      'User goal: fix the web page layout in Next.js and verify with screenshot in browser',
    );
    assert.strictEqual(mode, 'ui_and_api');
  });

  it('buildMasterVerificationWalkthroughPrompt requires browser checks only for ui mode', () => {
    const apiPrompt = buildMasterVerificationWalkthroughPrompt(
      'User goal: tell me current IP information',
    );
    assert.ok(apiPrompt.includes('Default to **N/A** for this mode.'));
    assert.ok(!apiPrompt.includes('Do **not** use screenshots'));

    const uiPrompt = buildMasterVerificationWalkthroughPrompt(
      'User goal: fix the website layout and verify screenshot in browser',
    );
    assert.ok(uiPrompt.includes('Playwright with local Google Chrome'));
    assert.ok(uiPrompt.includes('Do **not** use screenshots or image analysis'));
    assert.ok(uiPrompt.includes('Do **not** use Chrome DevTools MCP'));
    assert.ok(uiPrompt.includes('VERIFICATION_ACTION: UI_AND_API'));
  });
});
