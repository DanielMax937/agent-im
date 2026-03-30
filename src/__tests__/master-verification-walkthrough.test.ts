import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  MASTER_VERIFICATION_WALKTHROUGH_PREFIX,
  buildMasterVerificationWalkthroughPrompt,
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
  });

  it('buildMasterVerificationWalkthroughPrompt adds re-verification block when isReverify', () => {
    const p = buildMasterVerificationWalkthroughPrompt('ctx', { isReverify: true });
    assert.ok(p.includes('Re-verification'));
    assert.ok(p.includes('Loop until clean'));
  });
});
