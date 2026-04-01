import type {
  AgentRole,
  AgentRuntime,
  KanbanAgentKind,
  TaskConversationEntry,
  TaskQueueMessage,
  TaskSession,
} from './types';

const KANBAN_MONITOR_ROLE_LABELS: Record<AgentRole, string> = {
  developer: '开发',
  reviewer: '评审',
  tester: '测试',
};

/** Plain role name for monitor (与看板 lane 语义一致). */
export function formatKanbanMonitorTargetRole(role: AgentRole): string {
  return KANBAN_MONITOR_ROLE_LABELS[role];
}

/**
 * Monitor 列「source agent / target agent」统一：agent 为 `角色名/runtime`（如 `开发/claude`）。
 * 非 agent（Human、system check）不走此格式。
 */
export function formatMonitorAgentRoleRuntime(role: AgentRole, runtime: AgentRuntime): string {
  return `${KANBAN_MONITOR_ROLE_LABELS[role]}/${runtime}`;
}

/** Display label for the agent receiving this turn. */
export function formatKanbanTurnAgentLabel(
  kanbanAgent: KanbanAgentKind | undefined,
  role: AgentRole,
): string {
  const lane = kanbanAgent ?? '—';
  return `${lane}/${role}`;
}

function formatSourceAgentFromAssistantEntry(entry: TaskConversationEntry, runtime: AgentRuntime): string {
  if (entry.role !== 'assistant') return '';
  const src = entry.source;
  if (src === 'developer' || src === 'reviewer' || src === 'tester') {
    return formatMonitorAgentRoleRuntime(src, runtime);
  }
  return String(entry.source);
}

/**
 * Before appending this turn’s user message: first kickoff has no prior assistant → empty source.
 * Otherwise source is the last assistant’s `source` and response is its content.
 */
/**
 * Labels for `kanban_agent_turns`: source/target semantics for monitor.
 * - `human_followup`: Human → lane agent.
 * - `system_check`: prior agent → `system check`.
 * - Otherwise: prior handoff + target lane agent.
 */
export function buildKanbanMonitorTurnRecord(args: {
  queueMessage: TaskQueueMessage;
  taskSession: TaskSession;
  instanceRole: AgentRole;
  /** Runner 类型（claude / codex / …），与任务会话一致 */
  runtime: AgentRuntime;
  historyBeforeUser: TaskConversationEntry[];
}): { sourceAgent: string; sourceAgentResponse: string; targetAgent: string } {
  const { runtime } = args;
  const targetAgentLabel = formatMonitorAgentRoleRuntime(args.instanceRole, runtime);

  if (args.queueMessage.type === 'human_followup') {
    return { sourceAgent: 'Human', sourceAgentResponse: '', targetAgent: targetAgentLabel };
  }

  if (args.queueMessage.type === 'system_check') {
    const lastAssistant = [...args.historyBeforeUser].reverse().find((e) => e.role === 'assistant');
    const roleForLabel: AgentRole =
      lastAssistant?.source === 'developer' ||
      lastAssistant?.source === 'reviewer' ||
      lastAssistant?.source === 'tester'
        ? lastAssistant.source
        : args.instanceRole;
    const src = lastAssistant
      ? formatMonitorAgentRoleRuntime(roleForLabel, runtime)
      : formatMonitorAgentRoleRuntime(args.instanceRole, runtime);
    return {
      sourceAgent: src,
      sourceAgentResponse: lastAssistant?.content ?? '',
      targetAgent: 'system check',
    };
  }

  const base = resolveKanbanTurnSource({
    queueMessage: args.queueMessage,
    historyBeforeUser: args.historyBeforeUser,
    runtime,
  });
  return { ...base, targetAgent: targetAgentLabel };
}

export function resolveKanbanTurnSource(args: {
  queueMessage: TaskQueueMessage;
  /** History before this turn’s user message is appended. */
  historyBeforeUser: TaskConversationEntry[];
  runtime: AgentRuntime;
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
    sourceAgent: formatSourceAgentFromAssistantEntry(lastAssistant, args.runtime),
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
