import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseKanbanAction } from '../platform/kanban-workflow-parser';

describe('parseKanbanAction', () => {
  it('parses trailing single-line action', () => {
    assert.deepEqual(parseKanbanAction('Done.\n\nKANBAN_ACTION:SUBMIT_REVIEW'), {
      action: 'SUBMIT_REVIEW',
    });
  });

  it('parses action with payload after newline', () => {
    assert.deepEqual(
      parseKanbanAction('Summary.\nKANBAN_ACTION:REJECT_REVIEW\nFix the types in api.ts'),
      {
        action: 'REJECT_REVIEW',
        payload: 'Fix the types in api.ts',
      },
    );
  });

  it('returns null when marker missing', () => {
    assert.equal(parseKanbanAction('No marker here'), null);
  });

  it('uses last occurrence of marker', () => {
    assert.deepEqual(parseKanbanAction('KANBAN_ACTION:OLD\n\nKANBAN_ACTION:CLOSE'), {
      action: 'CLOSE',
    });
  });
});
