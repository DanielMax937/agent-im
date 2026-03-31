import type { AgentRole, KanbanAgentKind, TaskConversationEntry, TaskQueueMessage } from './types';

/** Display label for the agent receiving this turn. */
export function formatKanbanTurnAgentLabel(
  kanbanAgent: KanbanAgentKind | undefined,
  role: AgentRole,
): string {
  const lane = kanbanAgent ?? '—';
  return `${lane}/${role}`;
}

function formatSourceAgentFromAssistantEntry(entry: TaskConversationEntry): string {
  if (entry.role !== 'assistant') return '';
  return String(entry.source);
}

/**
 * Before appending this turn’s user message: first kickoff has no prior assistant → empty source.
 * Otherwise source is the last assistant’s `source` and response is its content.
 */
export function resolveKanbanTurnSource(args: {
  queueMessage: TaskQueueMessage;
  /** History before this turn’s user message is appended. */
  historyBeforeUser: TaskConversationEntry[];
}): { sourceAgent: string; sourceAgentResponse: string } {
  const lastAssistant = [...args.historyBeforeUser].reverse().find((e) => e.role === 'assistant');
  const isFirstKickoff = args.queueMessage.type === 'directive' && !lastAssistant;
  if (isFirstKickoff) {
    return { sourceAgent: '', sourceAgentResponse: '' };
  }
  if (!lastAssistant) {
    return { sourceAgent: '', sourceAgentResponse: '' };
  }
  return {
    sourceAgent: formatSourceAgentFromAssistantEntry(lastAssistant),
    sourceAgentResponse: lastAssistant.content,
  };
}

/**
 * Serialize the full prompt bundle sent to the agent runtime (system + history + this turn).
 */
export function formatKanbanAgentFullPrompt(args: {
  systemPrompt: string;
  conversationHistory: Array<{ role: string; content: string }>;
  /** Raw user message for this turn (same as last user entry in history when appended before the call). */
  userPrompt: string;
}): string {
  return [
    '=== SYSTEM PROMPT ===',
    args.systemPrompt,
    '',
    '=== CONVERSATION HISTORY (user/assistant, as passed to streamChat) ===',
    JSON.stringify(args.conversationHistory, null, 2),
    '',
    '=== USER MESSAGE (this turn) ===',
    args.userPrompt,
  ].join('\n');
}
