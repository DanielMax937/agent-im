import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadKanbanPlatformConfig, normalizeRunnersWithProcessEnvOverride } from '../config';

import { TEST_DEFAULT_RUNNER_ID } from './platform-test-helpers';

/**
 * `npm test` sets `CTI_RUNNERS` so the synthetic Kanban default id `test-runner` resolves to
 * Cursor + auto-approve (see `package.json` `test` script and `TEST_DEFAULT_RUNNER_ID`).
 */
describe('npm test runner profile (CTI_RUNNERS)', () => {
  it('defines test-runner as cursor with autoApprove true', () => {
    const cfg = loadKanbanPlatformConfig();
    const runners = normalizeRunnersWithProcessEnvOverride(cfg);
    const tr = runners.find((r) => r.id === TEST_DEFAULT_RUNNER_ID);
    assert.ok(tr, 'run `npm test` (or set CTI_RUNNERS like package.json) so test-runner exists');
    assert.equal(tr.runtime, 'cursor');
    assert.equal(tr.autoApprove, true);
  });
});
