import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveAutoApprove } from '../runtime-provider';
import type { RunnerConfig } from '../config';

const baseRunner: RunnerConfig = { id: 'r1', runtime: 'claude' };

describe('resolveAutoApprove (bridge × runner matrix)', () => {
  describe('bridge off (false)', () => {
    const config = { autoApprove: false as boolean | undefined };

    it('runner inherit (autoApprove omitted) → false', () => {
      assert.equal(resolveAutoApprove(config, undefined, { ...baseRunner }), false);
    });

    it('runner on → true', () => {
      assert.equal(
        resolveAutoApprove(config, undefined, { ...baseRunner, autoApprove: true }),
        true,
      );
    });

    it('runner off → false', () => {
      assert.equal(
        resolveAutoApprove(config, undefined, { ...baseRunner, autoApprove: false }),
        false,
      );
    });
  });

  describe('bridge on (true)', () => {
    const config = { autoApprove: true as boolean | undefined };

    it('runner inherit → true', () => {
      assert.equal(resolveAutoApprove(config, undefined, { ...baseRunner }), true);
    });

    it('runner on → true', () => {
      assert.equal(
        resolveAutoApprove(config, undefined, { ...baseRunner, autoApprove: true }),
        true,
      );
    });

    it('runner off → false', () => {
      assert.equal(
        resolveAutoApprove(config, undefined, { ...baseRunner, autoApprove: false }),
        false,
      );
    });
  });

  describe('bridge unset (undefined) — inherit falls through to ?? false', () => {
    const config = { autoApprove: undefined as boolean | undefined };

    it('runner inherit → false', () => {
      assert.equal(resolveAutoApprove(config, undefined, { ...baseRunner }), false);
    });

    it('runner on → true', () => {
      assert.equal(
        resolveAutoApprove(config, undefined, { ...baseRunner, autoApprove: true }),
        true,
      );
    });
  });
});

describe('resolveAutoApprove (autoApproveOverride)', () => {
  it('runner explicit beats override', () => {
    assert.equal(
      resolveAutoApprove({ autoApprove: false }, true, { ...baseRunner, autoApprove: false }),
      false,
    );
    assert.equal(
      resolveAutoApprove({ autoApprove: true }, false, { ...baseRunner, autoApprove: true }),
      true,
    );
  });

  it('when runner inherits, override beats bridge', () => {
    assert.equal(
      resolveAutoApprove({ autoApprove: true }, false, { ...baseRunner }),
      false,
    );
    assert.equal(
      resolveAutoApprove({ autoApprove: false }, true, { ...baseRunner }),
      true,
    );
  });

  it('when runner inherits and no override, uses bridge', () => {
    assert.equal(
      resolveAutoApprove({ autoApprove: true }, undefined, { ...baseRunner }),
      true,
    );
  });
});
