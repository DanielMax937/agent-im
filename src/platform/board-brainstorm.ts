import { renderPrompt } from '../prompts/loader';

/**
 * System prompt for board-side 「高级开发」 chat: brainstorming skill process
 * (context → one question at a time → approaches → design in sections → plan.md), no code unless asked.
 */
export const BOARD_BRAINSTORM_SYSTEM = renderPrompt('system/board-brainstorm');

export type BoardBrainstormIntent = 'chat' | 'draft' | 'revise';

export interface BoardBrainstormChatInput {
  intent: BoardBrainstormIntent;
  projectId: string;
  message: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  sessionId: string;
  sdkSessionId?: string;
  currentDraft?: string;
}

function parseBoardBrainstormIntent(raw: unknown): BoardBrainstormIntent {
  if (raw === undefined) return 'chat';
  if (raw === 'chat' || raw === 'draft' || raw === 'revise') return raw;
  throw new Error('intent must be chat, draft, or revise');
}

export function parseBoardBrainstormChatInput(raw: unknown): BoardBrainstormChatInput {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected JSON object');
  }
  const o = raw as Record<string, unknown>;
  const projectId = typeof o.projectId === 'string' ? o.projectId.trim() : '';
  const message = typeof o.message === 'string' ? o.message.trim() : '';
  const sessionId = typeof o.sessionId === 'string' ? o.sessionId.trim() : '';
  const intent = parseBoardBrainstormIntent(o.intent);

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
  const currentDraft =
    typeof o.currentDraft === 'string' && o.currentDraft.trim() ? o.currentDraft.trim() : undefined;

  if (intent === 'revise' && !currentDraft) {
    throw new Error('currentDraft is required for revise intent');
  }

  return { intent, projectId, message, conversationHistory, sessionId, sdkSessionId, currentDraft };
}

export function buildBoardBrainstormSystemPrompt(input: {
  intent: BoardBrainstormIntent;
  currentDraft?: string;
  vercelFramework?: string;
  laneHints: string[];
}): string {
  const fw = input.vercelFramework?.trim();
  return [
    BOARD_BRAINSTORM_SYSTEM,
    '',
    ...(input.intent === 'draft'
      ? [
          'Current request intent: draft.',
          'Generate only a complete structured Markdown design draft from the conversation. Do not include chat commentary.',
          'Use these headings exactly: # 方案稿, ## 目标, ## 范围, ## 非目标, ## 推荐方案, ## UI 设计, ## 数据与 API, ## 任务拆分建议, ## 验收标准, ## 风险与边界.',
          '',
        ]
      : []),
    ...(input.intent === 'revise'
      ? [
          'Current request intent: revise.',
          'Revise the current draft using the user revision instruction. Output only the new complete Markdown draft. Do not include diff notes or chat commentary.',
          'Current draft:',
          input.currentDraft ?? '',
          '',
        ]
      : []),
    ...(fw ? [`Vercel framework preset for this project: ${fw}.`, ''] : []),
    'Lane skill hints (optional):',
    ...input.laneHints.map((h) => `- ${h}`),
  ].join('\n');
}
