import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemCheckPrompt } from '../platform/kanban-confirmation';
import { buildRolePrompt } from '../platform/prompts';
import type { AgentRole, Project, Sprint, TaskSession, TaskWorkflowState } from '../platform/types';

function baseProject(): Project {
  return {
    id: 'project-1',
    name: 'Demo',
    repository: {
      remoteUrl: 'https://example.test/repo.git',
      localPath: '/tmp/demo',
      baseBranch: 'main',
      sprintBranchPrefix: 'feature/',
      taskBranchPrefix: 'task/',
      scmProvider: 'github',
      scmProject: 'org/repo',
    },
    agents: [],
    createdAt: '2026-04-02T00:00:00.000Z',
    updatedAt: '2026-04-02T00:00:00.000Z',
  };
}

function baseSprint(projectId: string): Sprint {
  return {
    id: 'sprint-1',
    projectId,
    name: 'Sprint 1',
    branchName: 'feature/sprint-1',
    baseBranch: 'main',
    status: 'active',
    taskIds: [],
    createdAt: '2026-04-02T00:00:00.000Z',
    updatedAt: '2026-04-02T00:00:00.000Z',
  };
}

function baseTask(workflowState: TaskWorkflowState, role: AgentRole): TaskSession {
  return {
    id: 'task-session-1',
    projectId: 'project-1',
    sprintId: 'sprint-1',
    taskId: 'TODOLIST-1',
    issueId: 'TODOLIST-1',
    title: 'Demo task',
    workflowState,
    runtime: 'claude',
    role,
    sessionId: 'session-1',
    workingDirectory: '/tmp/demo',
    branchName: 'task/todolist-1',
    messageQueueKey: 'TODOLIST-1:inbox',
    approvalQueueKey: 'TODOLIST-1:approvals',
    conversationHistory: [],
    createdAt: '2026-04-02T00:00:00.000Z',
    updatedAt: '2026-04-02T00:00:00.000Z',
  };
}

describe('Kanban prompts', () => {
  it('reviewer role prompt forbids approve-merge when PR is not merge-ready', () => {
    const project = baseProject();
    const sprint = baseSprint(project.id);
    const task = baseTask('review', 'reviewer');
    const prompt = buildRolePrompt({ role: 'reviewer', project, sprint, taskSession: task });

    assert.match(prompt, /do not emit `KANBAN_ACTION:APPROVE_MERGE`/);
    assert.match(prompt, /`KANBAN_ACTION:REJECT_REVIEW`/);
    assert.match(prompt, /Treat workflow notes about PR URL, mergeability, draft state, checks, or merge status as authoritative/i);
    assert.match(prompt, /the PR you must assess for `KANBAN_ACTION:APPROVE_MERGE` is the task review PR recorded on this task/i);
    assert.match(prompt, /Do not substitute a later integration\/release PR/i);
  });

  it('developer role prompt requires an explicit final action when lane work is done', () => {
    const project = baseProject();
    const sprint = baseSprint(project.id);
    const task = baseTask('in_progress', 'developer');
    const prompt = buildRolePrompt({ role: 'developer', project, sprint, taskSession: task });

    assert.match(prompt, /must end with the correct `KANBAN_ACTION:\.\.\.` final line/);
    assert.match(prompt, /When review is rejected because the PR is not merge-ready, treat that as active development work/i);
    assert.match(prompt, /When reviewer or tester finds an issue, fix it/i);
  });

  it('developer rework prompt tells the agent to address the latest reviewer comment first', () => {
    const project = baseProject();
    const sprint = baseSprint(project.id);
    const task = {
      ...baseTask('in_progress', 'developer'),
      reviewRejectionCount: 2,
      handoffComment: 'PR is dirty; resolve merge conflicts with the sprint branch.',
      conversationHistory: [
        {
          id: 'sys-1',
          role: 'system' as const,
          source: 'workflow' as const,
          content: 'Review rejected (round 2). Comment: PR is dirty; resolve merge conflicts with the sprint branch.',
          createdAt: '2026-04-02T00:00:00.000Z',
        },
      ],
    };
    const prompt = buildRolePrompt({ role: 'developer', project, sprint, taskSession: task });

    assert.match(prompt, /Developer rework rule:/);
    assert.match(prompt, /read the latest reviewer \/ workflow feedback/i);
    assert.match(prompt, /Do not reply with "already implemented"/);
    assert.match(prompt, /If the note is about mergeability, conflict, dirty PR, or blocked merge, you must do this sequence locally\. The target branch for this task is the sprint branch, not the repository base branch:/i);
    assert.match(prompt, /merge the target branch `feature\/sprint-1` into your task branch locally/i);
    assert.match(prompt, /target branch for this task is the sprint branch, not the repository base branch/i);
    assert.match(prompt, /Use the sprint branch `feature\/sprint-1` as the branch you pull and merge into your task branch/i);
    assert.match(prompt, /resolve all merge conflicts in code/i);
    assert.match(prompt, /commit the merge\/conflict-resolution changes/i);
    assert.match(prompt, /Fix reviewer findings and tester failures in code first\. Do not stop at explanation\./i);
    assert.match(prompt, /Latest reviewer \/ workflow feedback to address first:/);
  });

  it('developer rework prefers reviewer or workflow feedback over newer tester feedback', () => {
    const project = baseProject();
    const sprint = baseSprint(project.id);
    const task = {
      ...baseTask('in_progress', 'developer'),
      reviewRejectionCount: 3,
      handoffComment: 'Carry forward the reviewer mergeability note.',
      conversationHistory: [
        {
          id: 'review-1',
          role: 'assistant' as const,
          source: 'reviewer' as const,
          content: 'PR is dirty; rebase onto the sprint branch and resolve conflicts before testing again.',
          createdAt: '2026-04-02T00:00:00.000Z',
        },
        {
          id: 'tester-1',
          role: 'assistant' as const,
          source: 'tester' as const,
          content: 'Smoke test passed locally after the last build.',
          createdAt: '2026-04-02T00:01:00.000Z',
        },
      ],
    };
    const prompt = buildRolePrompt({ role: 'developer', project, sprint, taskSession: task });

    assert.match(prompt, /even if the task most recently came from the tester lane/i);
    assert.match(prompt, /Latest reviewer \/ workflow feedback to address first:/);
    assert.match(prompt, /PR is dirty; rebase onto the sprint branch and resolve conflicts before testing again\./);
    assert.doesNotMatch(prompt, /Smoke test passed locally after the last build\./);
  });

  it('developer rework treats merge-readiness-unknown rejection as local unblock work first', () => {
    const project = baseProject();
    const sprint = baseSprint(project.id);
    const task = {
      ...baseTask('in_progress', 'developer'),
      reviewRejectionCount: 4,
      pullRequestUrl: 'https://example.test/pr/42',
      handoffComment: 'Host PR merge-ready status unknown. PR URL: https://example.test/pr/42',
      conversationHistory: [
        {
          id: 'sys-1',
          role: 'system' as const,
          source: 'workflow' as const,
          content: 'Review rejected (round 4). Comment: Host PR merge-ready status unknown. PR URL: https://example.test/pr/42',
          createdAt: '2026-04-02T00:00:00.000Z',
        },
      ],
    };
    const prompt = buildRolePrompt({ role: 'developer', project, sprint, taskSession: task });

    assert.match(prompt, /you must do this sequence locally/i);
    assert.match(prompt, /fetch the latest target branch code from origin/i);
    assert.match(prompt, /merge the target branch `feature\/sprint-1` into your task branch locally/i);
    assert.match(prompt, /sprint branch, not the repository base branch/i);
    assert.match(prompt, /Use the PR URL in the handoff or workflow notes/i);
    assert.match(prompt, /Only conclude that the blocker is host-only after you have finished the full local merge-unblock sequence above/i);
    assert.match(prompt, /Only end with `KANBAN_ACTION:START_TESTING` after you have fixed the reviewer \/ tester issue/i);
  });

  it('system check tells reviewer to reject when PR is not merge-ready', () => {
    const prompt = buildSystemCheckPrompt(baseTask('review', 'reviewer'), 'reviewer');
    assert.match(prompt, /must NOT output `KANBAN_ACTION:APPROVE_MERGE`/);
    assert.match(prompt, /`KANBAN_ACTION:REJECT_REVIEW`/);
  });

  it('system check tells developer to emit START_TESTING when work is done', () => {
    const prompt = buildSystemCheckPrompt(baseTask('in_progress', 'developer'), 'developer');
    assert.match(prompt, /`KANBAN_ACTION:START_TESTING`/);
    assert.match(prompt, /do not send only a prose summary/);
    assert.match(prompt, /Do not use tester or reviewer actions from the developer lane/i);
    assert.doesNotMatch(prompt, /`KANBAN_ACTION:SUBMIT_REVIEW` \(tester\)/);
  });

  it('system check tells rejected developer tasks to fix reviewer feedback before START_TESTING', () => {
    const task = {
      ...baseTask('in_progress', 'developer'),
      reviewRejectionCount: 1,
      handoffComment: 'Resolve the merge issue from the last review comment.',
    };
    const prompt = buildSystemCheckPrompt(task, 'developer');
    assert.match(prompt, /latest reviewer\/workflow comment first/i);
    assert.match(prompt, /even if the task most recently came from the tester lane/i);
    assert.match(prompt, /pull the latest sprint branch code locally, merge the sprint branch into your dev branch, resolve conflicts, commit, push, then hand off/i);
    assert.match(prompt, /Do NOT end with `KANBAN_ACTION:START_TESTING` until the issue is actually fixed/i);
  });

  it('reviewer prompt requires PR URL in mergeability rejection when available', () => {
    const project = baseProject();
    const sprint = baseSprint(project.id);
    const task = {
      ...baseTask('review', 'reviewer'),
      pullRequestNumber: 42,
      pullRequestUrl: 'https://example.test/pr/42',
    };
    const prompt = buildRolePrompt({ role: 'reviewer', project, sprint, taskSession: task });

    assert.match(prompt, /always include the PR URL if it is available/i);
    assert.match(prompt, /Active review PR for this lane:/);
    assert.match(prompt, /Review PR URL: https:\/\/example\.test\/pr\/42/);
    assert.match(prompt, /Review PR number: #42/);
    assert.match(prompt, /Expected target branch for this review PR: `feature\/sprint-1`/);
    assert.match(prompt, /Use this task review PR as the authoritative host PR for the current review decision\./);
    assert.match(prompt, /Do not switch to a sprint->base release\/integration PR/i);
  });

  it('system check tells tester only testing-lane actions', () => {
    const prompt = buildSystemCheckPrompt(baseTask('testing', 'tester'), 'tester');
    assert.match(prompt, /`KANBAN_ACTION:SUBMIT_REVIEW`/);
    assert.match(prompt, /`KANBAN_ACTION:RETURN_TO_DEVELOPMENT`/);
    assert.match(prompt, /Do not use developer or reviewer actions from the tester lane/i);
    assert.doesNotMatch(prompt, /`KANBAN_ACTION:START_TESTING` \(developer\)/);
  });
});
