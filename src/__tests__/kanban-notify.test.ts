import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  formatKanbanToolInputForTelegram,
  isKanbanTelegramApprovalButtonsEnabled,
  parseKanbanPermCallbackData,
} from '../platform/kanban-notify';

describe('kanban-notify', () => {
  afterEach(() => {
    delete process.env.CTI_KANBAN_TELEGRAM_APPROVAL_BUTTONS;
  });

  it('isKanbanTelegramApprovalButtonsEnabled defaults off', () => {
    delete process.env.CTI_KANBAN_TELEGRAM_APPROVAL_BUTTONS;
    assert.equal(isKanbanTelegramApprovalButtonsEnabled(), false);
    process.env.CTI_KANBAN_TELEGRAM_APPROVAL_BUTTONS = '1';
    assert.equal(isKanbanTelegramApprovalButtonsEnabled(), true);
    process.env.CTI_KANBAN_TELEGRAM_APPROVAL_BUTTONS = 'true';
    assert.equal(isKanbanTelegramApprovalButtonsEnabled(), true);
    process.env.CTI_KANBAN_TELEGRAM_APPROVAL_BUTTONS = '0';
    assert.equal(isKanbanTelegramApprovalButtonsEnabled(), false);
  });

  it('formats tool input as JSON, not [object Object]', () => {
    assert.equal(formatKanbanToolInputForTelegram({ cmd: 'ls' }).includes('cmd'), true);
    assert.equal(formatKanbanToolInputForTelegram('plain'), 'plain');
  });

  it('parses kperm callback_data', () => {
    const id = 'tooluse_AbCdEfGhIj';
    assert.deepStrictEqual(parseKanbanPermCallbackData(`kperm:allow:${id}`), {
      behavior: 'allow',
      approvalId: id,
    });
    assert.deepStrictEqual(parseKanbanPermCallbackData(`kperm:deny:${id}`), {
      behavior: 'deny',
      approvalId: id,
    });
    assert.equal(parseKanbanPermCallbackData('other'), null);
  });
});
