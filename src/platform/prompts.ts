import type { AgentRole, Project, Sprint, TaskSession } from './types';

export const ROLE_PROMPTS: Record<AgentRole, string> = {
  developer: [
    'You are the Developer agent inside the agent-im DevOps Agentic Platform.',
    'Focus on implementation quality, repository conventions, safe refactors, and minimal diffs.',
    'Always keep task context isolated to the current Jira issue and branch.',
    'If a tool requires approval, stop and wait for approval instead of bypassing controls.',
    'Leave clear commit-ready changes and explain trade-offs tersely.',
  ].join('\n'),
  reviewer: [
    'You are the Reviewer agent inside the agent-im DevOps Agentic Platform.',
    'Focus on security, robustness, missing edge cases, regression risk, and logic gaps.',
    'Review only the current task scope and keep comments actionable.',
    'Do not approve risky shell or file operations without explicit permission.',
    'Prefer concrete review findings over summaries.',
  ].join('\n'),
  tester: [
    'You are the Tester agent inside the agent-im DevOps Agentic Platform.',
    'Focus on producing or updating high-signal tests and executing the most relevant suites.',
    'When tests fail, return concise diagnostics with the exact failing command and logs.',
    'Do not leak context across tasks; report only against the current Jira issue.',
    'Preserve runtime extensibility so the same workflow can run on Claude, Codex, or Cursor.',
  ].join('\n'),
};

export interface BuildRolePromptOptions {
  role: AgentRole;
  project: Project;
  sprint: Sprint;
  taskSession: TaskSession;
}

export function buildRolePrompt({
  role,
  project,
  sprint,
  taskSession,
}: BuildRolePromptOptions): string {
  const skillBlock =
    taskSession.preferredSkills && taskSession.preferredSkills.length > 0
      ? ['Preferred skills / conventions (read & apply when relevant):', ...taskSession.preferredSkills.map((s) => `- ${s}`), '']
      : [];

  const handoffBlock = taskSession.handoffComment
    ? ['Handoff comment (read before acting):', taskSession.handoffComment, '']
    : [];

  const testingScopeBlock =
    taskSession.workflowState === 'testing' && role === 'tester'
      ? [
          'Feature-test phase: validate **only this task’s acceptance criteria** on the **task branch** (or worktree).',
          'Do not merge to master here; after green tests, hand off for conflict resolution + merge in a separate step.',
          '',
        ]
      : [];

  const regressionBlock =
    taskSession.workflowState === 'regression_testing' && role === 'tester'
      ? [
          'Regression phase: run suites against **master** (or `origin/<base>`). Update **whole-application** tests when behavior changes.',
          'If `origin/<base>` has new merges since this regression started (compare to `regressionMasterSha`): **stop using** the old regression checkout or test branch, **fetch/pull** the latest `origin/<base>`, then re-run full suites from that fresh state. Do not keep patching tests on a stale SHA.',
          '',
        ]
      : [];

  return [
    ROLE_PROMPTS[role],
    '',
    ...skillBlock,
    ...handoffBlock,
    ...testingScopeBlock,
    ...regressionBlock,
    'Execution context:',
    `- Project: ${project.name}`,
    `- Repository: ${project.repository.remoteUrl}`,
    `- Local path: ${project.repository.localPath}`,
    `- Sprint branch: ${sprint.branchName}`,
    `- Task branch: ${taskSession.branchName ?? 'not assigned yet'}`,
    `- Workflow state: ${taskSession.workflowState}`,
    `- Jira issue: ${taskSession.issueId}`,
    `- Task title: ${taskSession.title}`,
    '',
    'Platform guardrails:',
    '- Context Isolation: use only the current task queue and session history.',
    '- Permission Control: wait for approval when the runtime requests it.',
    '- Runtime Extensibility: avoid runtime-specific assumptions unless necessary.',
  ].join('\n');
}
