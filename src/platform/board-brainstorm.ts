import { renderPrompt } from '../prompts/loader';

/**
 * System prompt for board-side 「高级开发」 chat: brainstorming skill process
 * (context → one question at a time → approaches → design in sections → plan.md), no code unless asked.
 */
export const BOARD_BRAINSTORM_SYSTEM = renderPrompt('system/board-brainstorm');

export interface BoardBrainstormChatInput {
  projectId: string;
  message: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  sessionId: string;
  sdkSessionId?: string;
}

export function parseBoardBrainstormChatInput(raw: unknown): BoardBrainstormChatInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected JSON object');
  }
  const o = raw as Record<string, unknown>;
  const projectId = typeof o.projectId === 'string' ? o.projectId.trim() : '';
  const message = typeof o.message === 'string' ? o.message.trim() : '';
  const sessionId = typeof o.sessionId === 'string' ? o.sessionId.trim() : '';

  if (!projectId) throw new Error('projectId is required');
  if (!message) throw new Error('message is required');
  if (!sessionId) throw new Error('sessionId is required');

  const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  if (o.conversationHistory !== undefined) {
    if (!Array.isArray(o.conversationHistory)) {
      throw new Error('conversationHistory must be an array');
    }
    for (const row of o.conversationHistory) {
      if (typeof row !== 'object' || row === null) {
        throw new Error('conversationHistory entries must be objects');
      }
      const r = row as Record<string, unknown>;
      const role = r.role === 'user' || r.role === 'assistant' ? r.role : null;
      const content = typeof r.content === 'string' ? r.content : '';
      if (!role || !content.trim()) {
        throw new Error('Each history entry needs role user|assistant and non-empty content');
      }
      conversationHistory.push({ role, content });
    }
  }

  const sdkSessionId =
    typeof o.sdkSessionId === 'string' && o.sdkSessionId.trim() ? o.sdkSessionId.trim() : undefined;

  return { projectId, message, conversationHistory, sessionId, sdkSessionId };
}
