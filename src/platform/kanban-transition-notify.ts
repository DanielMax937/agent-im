import crypto from 'node:crypto';

import { notifyKanbanTelegram } from './kanban-notify';
import type { AgentRole, TaskHistoryComment, TaskSession, TaskWorkflowState } from './types';

const ROLE_CN: Record<AgentRole, string> = {
  developer: '开发',
  reviewer: '评审',
  tester: '测试',
};

/**
 * Uses the **last assistant** line from this role as the handoff summary (proxy for “agent 总结”).
 * Configure Telegram with `CTI_KANBAN_TELEGRAM_BOT_TOKEN` + `CTI_KANBAN_TELEGRAM_CHAT_ID`
 * (optional `CTI_KANBAN_TELEGRAM_MESSAGE_THREAD_ID` for forum topics,
 * optional `CTI_KANBAN_TELEGRAM_PROXY` for outbound HTTP). No polling / getUpdates.
 */
export function buildOutgoingAgentSummaryFromConversation(
  taskSession: TaskSession,
  outgoingRole: AgentRole,
): string {
  const entries = taskSession.conversationHistory.filter(
    (e) => e.role === 'assistant' && e.source === outgoingRole,
  );
  if (entries.length === 0) {
    return '（该角色尚无 assistant 回复；转状态前请让当前 agent 至少输出一轮可见结论。）';
  }
  const last = entries[entries.length - 1]!;
  const text = last.content.trim();
  if (text.length > 3500) {
    return `${text.slice(0, 3500)}…`;
  }
  return text;
}

/** One persisted handoff row (same summary text as Telegram uses for the outgoing role). */
export function buildTransitionHistoryComment(
  task: TaskSession,
  from: TaskWorkflowState,
  to: TaskWorkflowState,
  outgoingRole: AgentRole | null,
  actionLabel: string,
): TaskHistoryComment {
  const content =
    outgoingRole === null
      ? '（本步无前序负责 agent 的会话输出。）'
      : buildOutgoingAgentSummaryFromConversation(task, outgoingRole);
  return {
    id: crypto.randomUUID(),
    role: outgoingRole,
    kind: 'transition',
    content,
    createdAt: new Date().toISOString(),
    transition: { from, to, actionLabel },
  };
}

/**
 * Before `workflowState` changes: send one Telegram with the outgoing agent’s last reply as summary.
 * If `outgoingRole` is null (e.g. todo→in_progress), only a short notice is sent.
 */
export async function notifyWorkflowStateTransition(args: {
  task: TaskSession;
  from: TaskWorkflowState;
  to: TaskWorkflowState;
  outgoingRole?: AgentRole | null;
  actionLabel: string;
}): Promise<void> {
  const token = process.env.CTI_KANBAN_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.CTI_KANBAN_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return;

  const lane = args.task.kanbanAgent ?? '—';
  const header = `[Kanban][${args.task.issueId}] ${args.task.title}\n状态 ${args.from} → ${args.to} · ${args.actionLabel}`;

  if (args.outgoingRole == null) {
    await notifyKanbanTelegram(`${header}\n（本步无前序负责 agent 的会话输出，无摘要。）`);
    return;
  }

  const summary = buildOutgoingAgentSummaryFromConversation(args.task, args.outgoingRole);
  const who = ROLE_CN[args.outgoingRole];
  await notifyKanbanTelegram(
    `${header}\n当前负责 lane: ${lane} · ${who} 工作摘要:\n${summary}`,
  );
}
