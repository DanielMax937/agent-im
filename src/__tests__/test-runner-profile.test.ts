import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadKanbanPlatformConfig, normalizeRunnersWithProcessEnvOverride } from '../config';

import { TEST_DEFAULT_RUNNER_ID, TEST_KANBAN_LANE_RUNNER_IDS } from './platform-test-helpers';

/**
 * `npm test` sets `CTI_RUNNERS` with per-lane Kanban runners (see `package.json` `test` script).
 */
describe('npm test runner profile (CTI_RUNNERS)', () => {
  it('defines Kanban lane runners with expected runtimes and autoApprove', () => {
    const cfg = loadKanbanPlatformConfig();
    const runners = normalizeRunnersWithProcessEnvOverride(cfg);
    const byId = new Map(runners.map((r) => [r.id, r]));
    const expected: Record<string, 'cursor' | 'codex' | 'claude' | 'copilot'> = {
      'test-kanban-dev': 'cursor',
      'test-codex-senior': 'codex',
      'test-claude-review': 'claude',
      'test-copilot-test': 'copilot',
    };
    for (const [id, runtime] of Object.entries(expected)) {
      const r = byId.get(id);
      assert.ok(r, `run \`npm test\` (or set CTI_RUNNERS like package.json) so ${id} exists`);
      assert.equal(r.runtime, runtime);
      assert.equal(r.autoApprove, true);
    }
    assert.equal(TEST_KANBAN_LANE_RUNNER_IDS['agent-dev'], TEST_DEFAULT_RUNNER_ID);
  });
});
