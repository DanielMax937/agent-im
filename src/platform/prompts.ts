import type { AgentRole, Project, Sprint, TaskSession } from './types';
import { renderPrompt } from '../prompts/loader';

export const ROLE_PROMPTS: Record<AgentRole, string> = {
  developer: renderPrompt('kanban/role-developer'),
  reviewer: renderPrompt('kanban/role-reviewer'),
  tester: renderPrompt('kanban/role-tester'),
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
  const latestReviewerOrWorkflowFeedback = [...taskSession.conversationHistory]
    .reverse()
    .find(
      (entry) =>
        (entry.role === 'assistant' && entry.source === 'reviewer') ||
        (entry.role === 'system' && entry.source === 'workflow'),
    );
  const latestReviewerOrWorkflowFeedbackPreview = latestReviewerOrWorkflowFeedback?.content.trim();

  const latestNonDeveloperFeedback = [...taskSession.conversationHistory]
    .reverse()
    .find(
      (entry) =>
        (entry.role === 'assistant' && entry.source !== 'developer') ||
        (entry.role === 'system' && entry.source === 'workflow'),
    );
  const latestNonDeveloperFeedbackPreview = latestNonDeveloperFeedback?.content.trim();

  const skillBlock =
    taskSession.preferredSkills && taskSession.preferredSkills.length > 0
      ? ['Preferred skills / conventions (read & apply when relevant):', ...taskSession.preferredSkills.map((s) => `- ${s}`), '']
      : [];

  const handoffBlock = taskSession.handoffComment
    ? ['Handoff comment (read before acting):', taskSession.handoffComment, '']
    : [];

  /** Same data as board “交接记录”: each transition stores the outgoing role’s last assistant reply as summary. */
  const historyLogBlock =
    taskSession.historyComments && taskSession.historyComments.length > 0
      ? [
          'Task transition log (per step: what the previous lane last said when the card moved; complements chat messages below):',
          ...taskSession.historyComments.slice(-40).map((h) => {
            const head = h.transition
              ? `${h.transition.from} → ${h.transition.to} · ${h.transition.actionLabel}`
              : 'note';
            const roleLabel = h.role ?? '—';
            const body = h.content.length > 4000 ? `${h.content.slice(0, 4000)}…` : h.content;
            return `[${roleLabel}] ${head}\n${body}`;
          }),
          '',
        ]
      : [];

  /** `appendWorkflowComment` stores `role: system` — those rows are omitted from LLM chat history; surface here. */
  const workflowNotesBlock = (() => {
    const lines = taskSession.conversationHistory
      .filter((e) => e.role === 'system' && e.source === 'workflow')
      .slice(-25)
      .map((e) => e.content.trim());
    if (lines.length === 0) return [];
    return [
      'Platform workflow notes (automated system lines; not repeated as chat turns below):',
      ...lines.map((c) => (c.length > 1200 ? `${c.slice(0, 1200)}…` : c)),
      '',
    ];
  })();

  const preTestingBlock =
    taskSession.workflowState === 'pre_testing' && role === 'tester'
      ? renderPrompt('kanban/block-pre-testing').split('\n')
      : [];

  const testingScopeBlock =
    taskSession.workflowState === 'testing' && role === 'tester'
      ? renderPrompt('kanban/block-testing-scope').split('\n')
      : [];

  const platformPort = process.env.PORT ?? '3300';

  const regressionBlock =
    taskSession.workflowState === 'regression_testing' && role === 'tester'
      ? renderPrompt('kanban/block-regression', {
          sprintBranchName: sprint.branchName,
          platformPort,
          projectId: project.id,
        }).split('\n')
      : [];

  const reviewPrBlock =
    role === 'reviewer' && taskSession.workflowState === 'review'
      ? renderPrompt('kanban/block-review-pr', {
          prUrl: taskSession.pullRequestUrl?.trim() || '(missing)',
          prNumber: taskSession.pullRequestNumber != null ? `#${taskSession.pullRequestNumber}` : '(missing)',
          sprintBranchName: sprint.branchName,
        }).split('\n')
      : [];

  const frameworkBlock = project.vercelDeploymentFramework?.trim()
    ? [
        'Deployment stack context:',
        `This repository targets Vercel with project framework preset "${project.vercelDeploymentFramework.trim()}" (Vercel API slug). Prefer that stack's idioms, directory layout, and tooling.`,
        '',
      ]
    : [];

  const developerReworkBlock =
    role === 'developer' && taskSession.workflowState === 'in_progress' && (taskSession.reviewRejectionCount ?? 0) > 0
      ? [
          ...renderPrompt('kanban/block-developer-rework-base').split('\n'),
          ...(latestReviewerOrWorkflowFeedbackPreview && /coverage|覆盖率/i.test(latestReviewerOrWorkflowFeedbackPreview)
            ? renderPrompt('kanban/block-developer-rework-coverage').split('\n')
            : []),
          ...renderPrompt('kanban/block-developer-rework-merge', {
            sprintBranchName: sprint.branchName,
          }).split('\n'),
          ...(latestReviewerOrWorkflowFeedbackPreview
            ? [
                'Latest reviewer / workflow feedback to address first:',
                latestReviewerOrWorkflowFeedbackPreview.length > 1600
                  ? `${latestReviewerOrWorkflowFeedbackPreview.slice(0, 1600)}…`
                  : latestReviewerOrWorkflowFeedbackPreview,
                '',
              ]
            : latestNonDeveloperFeedbackPreview
              ? [
                  'No reviewer-specific note was found. Fallback non-developer feedback:',
                  latestNonDeveloperFeedbackPreview.length > 1600
                    ? `${latestNonDeveloperFeedbackPreview.slice(0, 1600)}…`
                    : latestNonDeveloperFeedbackPreview,
                  '',
                ]
              : []),
        ]
      : [];

  return [
    ROLE_PROMPTS[role],
    '',
    ...frameworkBlock,
    ...skillBlock,
    ...handoffBlock,
    ...historyLogBlock,
    ...workflowNotesBlock,
    ...reviewPrBlock,
    ...preTestingBlock,
    ...testingScopeBlock,
    ...regressionBlock,
    ...developerReworkBlock,
    ...renderPrompt('kanban/block-execution-context', {
      projectName: project.name,
      repoUrl: project.repository.remoteUrl,
      localPath: project.repository.localPath,
      sprintBranch: sprint.branchName,
      taskBranch: taskSession.branchName ?? 'not assigned yet',
      workflowState: taskSession.workflowState,
      issueId: taskSession.issueId,
      taskTitle: taskSession.title,
    }).split('\n'),
    ...renderPrompt('kanban/block-platform-guardrails').split('\n'),
    ...renderPrompt('kanban/block-workflow-automation').split('\n'),
  ].join('\n');
}
