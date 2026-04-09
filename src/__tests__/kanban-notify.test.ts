import assert from 'node:assert';
import { afterEach, describe, it } from 'node:test';

import {
  formatKanbanToolInputForTelegram,
  isKanbanTelegramApprovalButtonsEnabled,
  parseKanbanPermCallbackData,
  shouldSkipKanbanTelegramConversationEntry,
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

  it('skips Telegram only for workflow user lines that open the system-check prompt', () => {
    assert.equal(
      shouldSkipKanbanTelegramConversationEntry({
        role: 'user',
        source: 'workflow',
        content: '[Kanban system check — respond in your next assistant message]\n\nCurrent workflow state:',
      }),
      true,
    );
    assert.equal(
      shouldSkipKanbanTelegramConversationEntry({
        role: 'user',
        source: 'workflow',
        content: '  \n[Kanban system check — x]',
      }),
      true,
    );
    assert.equal(
      shouldSkipKanbanTelegramConversationEntry({
        role: 'user',
        source: 'workflow',
        content: 'Begin work on task ISSUE-1: title.',
      }),
      false,
    );
    assert.equal(
      shouldSkipKanbanTelegramConversationEntry({
        role: 'assistant',
        source: 'workflow',
        content: '[Kanban system check — copied by mistake]',
      }),
      false,
    );
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
