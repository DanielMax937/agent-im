import type { AgentRole, AgentRuntime, KanbanAgentKind } from './types';

export interface KanbanAgentResolution {
  role: AgentRole;
  runtime: AgentRuntime;
  kanbanAgent: KanbanAgentKind;
  /** Suggested Cursor/Claude skill names to mention in the system prompt. */
  preferredSkills: string[];
}

const SKILL_PRESETS: Record<KanbanAgentKind, string[]> = {
  'agent-dev': [
    'vercel-react-best-practices（React 规范与性能）',
    'gof-patterns（设计模式精简：策略/工厂等，避免过度设计）',
    '减少无关代码与注释 — 最小可行改动',
  ],
  'codex-senior': [
    'vercel-react-best-practices（React 规范）',
    'gof-patterns（设计模式精简）',
    'subagent-driven-development / systematic-debugging when complex',
  ],
  'claude-review': [
    'gof-patterns（设计模式精简）',
    'receiving-code-review / requesting-code-review',
    'security: trust boundaries、shell/文件操作与注入面安全检查',
  ],
  'copilot-test': [
    'test-driven-development',
    'verification-before-completion',
    '仅验证本 task 功能点；合并冲突与合入 master 在后续步骤处理',
  ],
};

/**
 * Maps UI agent lane → platform role/runtime. Escalation to Codex is handled in WorkflowService
 * when `reviewRejectionCount > 2` (i.e. third reject from review onward) for developer assignments.
 */
export function resolveKanbanAgent(
  kind: KanbanAgentKind,
  reviewRejectionCount = 0,
): KanbanAgentResolution {
  if (kind === 'agent-dev' && reviewRejectionCount > 2) {
    return {
      role: 'developer',
      runtime: 'codex',
      kanbanAgent: 'codex-senior',
      preferredSkills: SKILL_PRESETS['codex-senior'],
    };
  }

  switch (kind) {
    case 'agent-dev':
      return {
        role: 'developer',
        runtime: 'claude',
        kanbanAgent: 'agent-dev',
        preferredSkills: SKILL_PRESETS['agent-dev'],
      };
    case 'codex-senior':
      return {
        role: 'developer',
        runtime: 'codex',
        kanbanAgent: 'codex-senior',
        preferredSkills: SKILL_PRESETS['codex-senior'],
      };
    case 'claude-review':
      return {
        role: 'reviewer',
        runtime: 'claude',
        kanbanAgent: 'claude-review',
        preferredSkills: SKILL_PRESETS['claude-review'],
      };
    case 'copilot-test':
      return {
        role: 'tester',
        runtime: 'copilot',
        kanbanAgent: 'copilot-test',
        preferredSkills: SKILL_PRESETS['copilot-test'],
      };
  }
}
