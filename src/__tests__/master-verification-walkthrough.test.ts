import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  MASTER_VERIFICATION_WALKTHROUGH_PREFIX,
  buildMasterVerificationWalkthroughPrompt,
  inferMasterVerificationMode,
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
    assert.ok(!apiPrompt.includes('Screenshots are mandatory'));

    const uiPrompt = buildMasterVerificationWalkthroughPrompt(
      'User goal: fix the website layout and verify screenshot in browser',
    );
    assert.ok(uiPrompt.includes('Screenshots are mandatory'));
    assert.ok(uiPrompt.includes('VERIFICATION_ACTION: UI_AND_API'));
  });
});
