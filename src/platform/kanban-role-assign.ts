import type { AgentRole, KanbanAgentKind, KanbanRoleMember, Project, TaskSession } from './types';

/** Members for a lane: explicit roster, else legacy single `kanbanRoleRunners[kind]` as one default member. */
export function membersForKind(project: Project, kind: KanbanAgentKind): KanbanRoleMember[] {
  const roster = project.kanbanRoleMembers?.[kind];
  if (roster && roster.length > 0) return roster;
  const legacy = project.kanbanRoleRunners?.[kind]?.trim();
  if (legacy) {
    return [{ id: '__legacy_default__', name: 'Default', runnerProfileId: legacy }];
  }
  return [];
}

export function isTaskActiveForKindAssignee(t: TaskSession, kind: KanbanAgentKind): boolean {
  if (kind === 'agent-dev' || kind === 'codex-senior') {
    return t.workflowState === 'in_progress' && t.kanbanAgent === kind;
  }
  if (kind === 'pre-tester') {
    return t.workflowState === 'pre_testing';
  }
  if (kind === 'claude-review') {
    return t.workflowState === 'review';
  }
  if (kind === 'copilot-test') {
    return t.workflowState === 'testing' || t.workflowState === 'regression_testing';
  }
  return false;
}

export function countLoadForMember(
  tasks: TaskSession[],
  kind: KanbanAgentKind,
  memberId: string,
): number {
  return tasks.filter(
    (t) =>
      t.kanbanAssignees?.[kind] === memberId && isTaskActiveForKindAssignee(t, kind),
  ).length;
}

export interface ResolveKanbanAssignmentOptions {
  runtimeProfileId?: string;
  /**
   * Manual pick — only used by **`assignTask` / `assignFromTodo`** (first allocation from todo or legacy assign).
   * All other workflow transitions (review, test, reject, regression, …) must call with `{}` (automatic only).
   */
  assigneeMemberId?: string;
  /** Default true. When false with manual assignee API, `assigneeMemberId` is required if members exist. */
  autoAssign?: boolean;
}

/**
 * Picks a roster member (sticky or least-loaded) when `kanbanRoleMembers` / legacy mapping exists.
 * Returns `member: null` when no roster — caller should use `pickRuntimeProfile` only.
 */
export function resolveKanbanAssignment(
  project: Project,
  kind: KanbanAgentKind,
  taskSession: TaskSession,
  projectTasks: TaskSession[],
  options: ResolveKanbanAssignmentOptions,
): { member: KanbanRoleMember | null; runtimeProfileIdHint?: string } {
  const members = membersForKind(project, kind);
  const explicit = options.runtimeProfileId?.trim();

  if (members.length === 0) {
    return { member: null, runtimeProfileIdHint: explicit || undefined };
  }

  const autoAssign = options.autoAssign !== false;

  let member: KanbanRoleMember | null = null;

  if (options.assigneeMemberId?.trim()) {
    member = members.find((m) => m.id === options.assigneeMemberId!.trim()) ?? null;
    if (!member) {
      throw new Error(`Unknown assigneeMemberId for lane ${kind}: ${options.assigneeMemberId}`);
    }
  } else if (autoAssign) {
    const sticky = taskSession.kanbanAssignees?.[kind];
    if (sticky && members.some((m) => m.id === sticky)) {
      member = members.find((m) => m.id === sticky)!;
    } else {
      const scored = members.map((m) => ({
        m,
        c: countLoadForMember(projectTasks, kind, m.id),
      }));
      const minC = Math.min(...scored.map((s) => s.c));
      const tied = scored.filter((s) => s.c === minC);
      tied.sort((a, b) => a.m.id.localeCompare(b.m.id));
      member = tied[0]!.m;
    }
  } else {
    throw new Error(`assigneeMemberId is required for lane ${kind} when autoAssign is false`);
  }

  const runtimeProfileIdHint = explicit || member.runnerProfileId;
  return { member, runtimeProfileIdHint };
}

export function mergeKanbanAssignee(
  taskSession: TaskSession,
  kind: KanbanAgentKind,
  memberId: string | undefined,
): Partial<TaskSession> {
  if (!memberId) return {};
  return {
    kanbanAssignees: {
      ...(taskSession.kanbanAssignees ?? {}),
      [kind]: memberId,
    },
  };
}

/** Single-lane default runner id from `kanbanRoleRunners` (same as board「单 lane 默认 runner」). */
export function laneDefaultRunnerProfileId(project: Project, kind: KanbanAgentKind): string | undefined {
  const v = project.kanbanRoleRunners?.[kind]?.trim();
  return v || undefined;
}

/** Lane kind for resolving defaults when `taskSession.kanbanAgent` is unset. */
export function kanbanLaneKindForInstance(taskSession: TaskSession, role: AgentRole): KanbanAgentKind {
  if (taskSession.kanbanAgent) return taskSession.kanbanAgent;
  if (role === 'reviewer') return 'claude-review';
  if (role === 'tester') return 'copilot-test';
  return 'agent-dev';
}
