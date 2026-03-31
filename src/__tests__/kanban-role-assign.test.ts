import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  countLoadForMember,
  membersForKind,
  resolveKanbanAssignment,
} from '../platform/kanban-role-assign';
import type { KanbanRoleMember, Project, TaskSession } from '../platform/types';

const baseProject = (members: Partial<Record<string, KanbanRoleMember[]>>): Project => ({
  id: 'p1',
  name: 'P',
  repository: {
    remoteUrl: 'x',
    localPath: '/tmp',
    baseBranch: 'main',
    sprintBranchPrefix: 's/',
    taskBranchPrefix: 'd/',
    scmProvider: 'github',
    scmProject: 'x/y',
  },
  agents: [],
  createdAt: '',
  updatedAt: '',
  kanbanRoleMembers: members as Project['kanbanRoleMembers'],
});

describe('kanban-role-assign', () => {
  it('membersForKind uses roster then legacy single runner', () => {
    const a: KanbanRoleMember = { id: 'a', name: 'A', runnerProfileId: 'r1' };
    assert.deepEqual(membersForKind(baseProject({ 'agent-dev': [a] }), 'agent-dev'), [a]);
    const legacy = baseProject({});
    legacy.kanbanRoleRunners = { 'agent-dev': 'legacy-runner' };
    assert.equal(membersForKind(legacy, 'agent-dev').length, 1);
    assert.equal(membersForKind(legacy, 'agent-dev')[0]!.runnerProfileId, 'legacy-runner');
  });

  it('resolveKanbanAssignment sticks to prior assignee when still in roster', () => {
    const m1: KanbanRoleMember = { id: 'u1', name: 'One', runnerProfileId: 'r1' };
    const m2: KanbanRoleMember = { id: 'u2', name: 'Two', runnerProfileId: 'r2' };
    const project = baseProject({ 'agent-dev': [m1, m2] });
    const taskSession = {
      kanbanAssignees: { 'agent-dev': 'u2' },
    } as TaskSession;
    const tasks: TaskSession[] = [];
    const { member } = resolveKanbanAssignment(project, 'agent-dev', taskSession, tasks, {});
    assert.equal(member?.id, 'u2');
  });

  it('resolveKanbanAssignment picks least loaded when no sticky', () => {
    const m1: KanbanRoleMember = { id: 'u1', name: 'One', runnerProfileId: 'r1' };
    const m2: KanbanRoleMember = { id: 'u2', name: 'Two', runnerProfileId: 'r2' };
    const project = baseProject({ 'agent-dev': [m1, m2] });
    const taskSession = {} as TaskSession;
    const tasks: TaskSession[] = [
      {
        id: 't1',
        workflowState: 'in_progress',
        kanbanAgent: 'agent-dev',
        kanbanAssignees: { 'agent-dev': 'u1' },
      } as TaskSession,
    ];
    const { member } = resolveKanbanAssignment(project, 'agent-dev', taskSession, tasks, {});
    assert.equal(member?.id, 'u2');
    assert.equal(countLoadForMember(tasks, 'agent-dev', 'u1'), 1);
    assert.equal(countLoadForMember(tasks, 'agent-dev', 'u2'), 0);
  });
});
