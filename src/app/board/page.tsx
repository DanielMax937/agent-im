'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AgentRole,
  KanbanAgentKind,
  KanbanRoleMember,
  Project,
  Sprint,
  TaskConversationEntry,
  TaskHistoryComment,
  TaskSession,
  TaskWorkflowState,
} from '../../platform/types';

/** Order matches pipeline: 开发 → 功能测试 → PR 评审 → 合并后回归 → 合并主干 → 完成 */
const COLUMNS: { key: TaskWorkflowState; label: string }[] = [
  { key: 'todo', label: '待办' },
  { key: 'pending_start', label: '队列' },
  { key: 'in_progress', label: '开发中' },
  { key: 'testing', label: '测试中' },
  { key: 'review', label: '评审中' },
  { key: 'regression_testing', label: '回归测试中' },
  { key: 'pending_release', label: '合并主干' },
  { key: 'closed', label: '完成' },
];

const ROLE_LABELS: Record<string, string> = {
  developer: '开发',
  reviewer: '评审',
  tester: '测试',
};

const KANBAN_AGENT_LABELS: Record<KanbanAgentKind, string> = {
  'agent-dev': 'agent-开发',
  'claude-review': 'claude-review',
  'copilot-test': 'copilot-测试',
  'codex-senior': 'codex-高级开发',
};

const TODO_ASSIGN_AGENTS: KanbanAgentKind[] = ['agent-dev', 'codex-senior'];

function todoAssigneeOptionValue(kind: KanbanAgentKind, memberId: string): string {
  return `${kind}:${memberId}`;
}

function parseTodoAssigneeOptionValue(raw: string): { kind: KanbanAgentKind; memberId: string } | null {
  const i = raw.indexOf(':');
  if (i <= 0) return null;
  const kind = raw.slice(0, i) as KanbanAgentKind;
  const memberId = raw.slice(i + 1);
  if (!memberId || !TODO_ASSIGN_AGENTS.includes(kind)) return null;
  return { kind, memberId };
}

/** 自动从待办领取时：评审打回次数 &gt; 2 用高级开发 lane，否则普通开发（与后端 `resolveKanbanAgent` 一致）。 */
function inferKanbanAgentForTodoAuto(task: TaskSession): KanbanAgentKind {
  const c = task.reviewRejectionCount ?? 0;
  if (c > 2) return 'codex-senior';
  return 'agent-dev';
}

const ROLE_SOURCE_LABELS: Record<'developer' | 'reviewer' | 'tester', string> = {
  developer: '开发',
  reviewer: '评审',
  tester: '测试',
};

function sortConversationEntries(entries: TaskConversationEntry[]): TaskConversationEntry[] {
  return [...entries].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function formatAssigneeCell(
  kind: KanbanAgentKind,
  memberId: string | undefined,
  members: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> | null,
): string {
  const lane = KANBAN_AGENT_LABELS[kind];
  if (!memberId) return `${lane}: —`;
  const list = members?.[kind] ?? [];
  const m = list.find((x) => x.id === memberId);
  return `${lane}: ${m ? `${m.name} (${memberId})` : memberId}`;
}

function formatHistoryCommentMeta(c: TaskHistoryComment, workflowLabel: (s: TaskWorkflowState) => string): string {
  if (c.kind === 'manual') {
    const role = c.role ? ROLE_LABELS[c.role] ?? c.role : '未标注角色';
    return `手动备注 · ${role}`;
  }
  const t = c.transition!;
  const who = c.role ? ROLE_LABELS[c.role] ?? c.role : '—';
  return `交接 · ${who} · ${t.actionLabel}（${workflowLabel(t.from)} → ${workflowLabel(t.to)}）`;
}

type TaskDetailTab = 'overview' | 'history' | 'dialog';

type KanbanStatus = {
  projects: Project[];
  tasksByState: Record<TaskWorkflowState, number>;
  instances: unknown[];
  tasksByProject?: {
    projectId: string;
    name: string;
    owner?: string;
    tasksByState: Record<TaskWorkflowState, number>;
  }[];
};

export default function BoardPage() {
  const [tasks, setTasks] = useState<TaskSession[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sprints, setSprints] = useState<Sprint[]>([]);
  /** 看板任务列表筛选（空 = 显示全部项目） */
  const [filterProjectId, setFilterProjectId] = useState('');
  /** 新建任务 / 迭代 / 预览 Issue 所用项目 */
  const [createProjectId, setCreateProjectId] = useState('');
  const [sprintId, setSprintId] = useState('');
  const [nextIssueHint, setNextIssueHint] = useState('');
  const [newSprintName, setNewSprintName] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  /** Same-project tasks for the dependency multi-select (full list; board `tasks` may be filtered). */
  const [dependencyPickerTasks, setDependencyPickerTasks] = useState<TaskSession[]>([]);
  /** Selected `issueId`s that must close before this card leaves the queue */
  const [createDependsOnIssueIds, setCreateDependsOnIssueIds] = useState<string[]>([]);
  const [createDepsDropdownOpen, setCreateDepsDropdownOpen] = useState(false);
  const createDepsDropdownRef = useRef<HTMLDivElement>(null);
  /** 待办批量领取：弹窗开关与选中任务 id */
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [bulkSelectedTaskIds, setBulkSelectedTaskIds] = useState<string[]>([]);
  const [bulkHandoff, setBulkHandoff] = useState('');
  const [bulkAssignMode, setBulkAssignMode] = useState<'auto' | 'manual'>('auto');
  const [bulkAssigneeOptionValue, setBulkAssigneeOptionValue] = useState('');
  const [bulkLaneMembersByKind, setBulkLaneMembersByKind] = useState<
    Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> | null
  >(null);
  /** 合并主干列：批量标记完成 */
  const [bulkCloseOpen, setBulkCloseOpen] = useState(false);
  const [bulkCloseSelectedTaskIds, setBulkCloseSelectedTaskIds] = useState<string[]>([]);
  /** 待办领取弹窗：当前选中的任务；null 表示关闭 */
  const [assignModalTask, setAssignModalTask] = useState<TaskSession | null>(null);
  const [modalHandoff, setModalHandoff] = useState('');
  /** Loaded when assign modal opens — project kanbanRoleMembers from API */
  const [laneMembersByKind, setLaneMembersByKind] = useState<
    Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> | null
  >(null);
  const [modalAssignMode, setModalAssignMode] = useState<'auto' | 'manual'>('auto');
  /** `kind:memberId` for manual pick; lane inferred from which roster the person belongs to */
  const [modalAssigneeOptionValue, setModalAssigneeOptionValue] = useState('');
  const [kanbanStatus, setKanbanStatus] = useState<KanbanStatus | null>(null);
  /** 非待办 / 非完成列：手动向消息队列写入内容，驱动当前 lane agent 继续 */
  const [manualModalTask, setManualModalTask] = useState<TaskSession | null>(null);
  const [manualQueueText, setManualQueueText] = useState('');
  /** 标题点击查看：完整任务、分配快照、工作流记录、各 lane 对话 */
  const [taskDetailModal, setTaskDetailModal] = useState<TaskSession | null>(null);
  const [taskDetailSprint, setTaskDetailSprint] = useState<Sprint | null>(null);
  const [taskDetailMembers, setTaskDetailMembers] = useState<
    Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> | null
  >(null);
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [taskDetailTab, setTaskDetailTab] = useState<TaskDetailTab>('overview');
  const [detailCommentText, setDetailCommentText] = useState('');
  const [detailCommentRole, setDetailCommentRole] = useState<'' | AgentRole>('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const modalTodoAssignOptions = useMemo(() => {
    if (!laneMembersByKind) return [];
    const out: { kind: KanbanAgentKind; member: KanbanRoleMember }[] = [];
    for (const kind of TODO_ASSIGN_AGENTS) {
      for (const member of laneMembersByKind[kind] ?? []) {
        out.push({ kind, member });
      }
    }
    return out;
  }, [laneMembersByKind]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const taskUrl = filterProjectId
        ? `/api/tasks?projectId=${encodeURIComponent(filterProjectId)}`
        : '/api/tasks';
      const [taskRes, projRes] = await Promise.all([fetch(taskUrl), fetch('/api/projects')]);
      if (!taskRes.ok) throw new Error(await taskRes.text());
      if (!projRes.ok) throw new Error(await projRes.text());
      const taskBody = (await taskRes.json()) as TaskSession[];
      const projBody = (await projRes.json()) as Project[];
      setTasks(Array.isArray(taskBody) ? taskBody : []);
      setProjects(Array.isArray(projBody) ? projBody : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filterProjectId]);

  const silentRefreshTasks = useCallback(async () => {
    try {
      const taskUrl = filterProjectId
        ? `/api/tasks?projectId=${encodeURIComponent(filterProjectId)}`
        : '/api/tasks';
      const taskRes = await fetch(taskUrl, { cache: 'no-store' });
      if (!taskRes.ok) return;
      const taskBody = (await taskRes.json()) as TaskSession[];
      setTasks(Array.isArray(taskBody) ? taskBody : []);
    } catch {
      /* ignore transient poll errors */
    }
  }, [filterProjectId]);

  const loadSprints = useCallback(async (pid: string) => {
    if (!pid) {
      setSprints([]);
      setSprintId('');
      return;
    }
    try {
      const res = await fetch(`/api/sprints?projectId=${encodeURIComponent(pid)}`);
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as Sprint[];
      const list = Array.isArray(body) ? body : [];
      setSprints(list);
      setSprintId((prev) => (list.some((s) => s.id === prev) ? prev : list[0]?.id ?? ''));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => void silentRefreshTasks(), 5000);
    return () => clearInterval(id);
  }, [silentRefreshTasks]);

  useEffect(() => {
    if (createProjectId) void loadSprints(createProjectId);
  }, [createProjectId, loadSprints]);

  const loadDependencyPickerTasks = useCallback(async (projectId: string) => {
    if (!projectId) {
      setDependencyPickerTasks([]);
      return;
    }
    try {
      const res = await fetch(`/api/tasks?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as TaskSession[];
      setDependencyPickerTasks(Array.isArray(body) ? body : []);
    } catch {
      /* ignore transient errors */
    }
  }, []);

  useEffect(() => {
    void loadDependencyPickerTasks(createProjectId);
  }, [createProjectId, loadDependencyPickerTasks]);

  useEffect(() => {
    if (!createDepsDropdownOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = createDepsDropdownRef.current;
      if (el && !el.contains(e.target as Node)) setCreateDepsDropdownOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [createDepsDropdownOpen]);

  useEffect(() => {
    if (projects.length === 0) return;
    setCreateProjectId((prev) => prev || projects[0].id);
  }, [projects]);

  useEffect(() => {
    if (!assignModalTask) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setAssignModalTask(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [assignModalTask]);

  useEffect(() => {
    if (!manualModalTask) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setManualModalTask(null);
        setManualQueueText('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [manualModalTask]);

  useEffect(() => {
    if (!taskDetailModal) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTaskDetailModal(null);
        setTaskDetailSprint(null);
        setTaskDetailMembers(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [taskDetailModal]);

  useEffect(() => {
    if (!createProjectId) {
      setNextIssueHint('');
      return;
    }
    let cancelled = false;
    void fetch(`/api/projects/${encodeURIComponent(createProjectId)}/next-issue-id`, { cache: 'no-store' })
      .then(async (res) => {
        const data = (await res.json()) as { issueId?: string; error?: string };
        if (!cancelled && res.ok && data.issueId) setNextIssueHint(data.issueId);
        else if (!cancelled) setNextIssueHint('');
      })
      .catch(() => {
        if (!cancelled) setNextIssueHint('');
      });
    return () => {
      cancelled = true;
    };
  }, [createProjectId, tasks]);

  async function startSprint() {
    if (!createProjectId || !newSprintName.trim()) {
      setError('请选择项目并填写迭代名称（如 Sprint 1）');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/workflows/sprints/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: createProjectId,
          sprintName: newSprintName.trim(),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setNewSprintName('');
      await loadSprints(createProjectId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const byColumn = useMemo(() => {
    const map = new Map<TaskWorkflowState, TaskSession[]>();
    for (const col of COLUMNS) map.set(col.key, []);
    for (const t of tasks) {
      const list = map.get(t.workflowState);
      if (list) list.push(t);
    }
    return map;
  }, [tasks]);

  const todoColumnTasks = useMemo(() => (byColumn.get('todo') ?? []).slice(), [byColumn]);

  const pendingReleaseColumnTasks = useMemo(
    () => (byColumn.get('pending_release') ?? []).slice(),
    [byColumn],
  );

  const bulkAssignProjectIdForRoles = useMemo(() => {
    const selected = todoColumnTasks.filter((t) => bulkSelectedTaskIds.includes(t.id));
    if (selected.length === 0) return null;
    const pids = new Set(selected.map((t) => t.projectId));
    if (pids.size !== 1) return null;
    return [...pids][0]!;
  }, [todoColumnTasks, bulkSelectedTaskIds]);

  const bulkModalTodoAssignOptions = useMemo(() => {
    if (!bulkLaneMembersByKind) return [];
    const out: { kind: KanbanAgentKind; member: KanbanRoleMember }[] = [];
    for (const kind of TODO_ASSIGN_AGENTS) {
      for (const member of bulkLaneMembersByKind[kind] ?? []) {
        out.push({ kind, member });
      }
    }
    return out;
  }, [bulkLaneMembersByKind]);

  const bulkSelectedSpansMultipleProjects = useMemo(() => {
    const selected = todoColumnTasks.filter((t) => bulkSelectedTaskIds.includes(t.id));
    if (selected.length < 2) return false;
    return new Set(selected.map((t) => t.projectId)).size > 1;
  }, [todoColumnTasks, bulkSelectedTaskIds]);

  const createDependencyOptions = useMemo(() => {
    return [...dependencyPickerTasks].sort((a, b) => a.issueId.localeCompare(b.issueId));
  }, [dependencyPickerTasks]);

  const createDepsTriggerLabel = useMemo(() => {
    if (createDependsOnIssueIds.length === 0) return '选择依赖 Issue…';
    if (createDependsOnIssueIds.length <= 2) return createDependsOnIssueIds.join('、');
    return `${createDependsOnIssueIds.slice(0, 2).join('、')} 等 ${createDependsOnIssueIds.length} 项`;
  }, [createDependsOnIssueIds]);

  function toggleCreateDepIssue(issueId: string) {
    setCreateDependsOnIssueIds((prev) =>
      prev.includes(issueId) ? prev.filter((id) => id !== issueId) : [...prev, issueId],
    );
  }

  async function createTask() {
    if (!createProjectId || !sprintId || !createTitle.trim()) {
      setError('请选择项目、迭代，并填写标题（Issue ID 将按项目自动生成）');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const dependsOnIssueIds =
        createDependsOnIssueIds.length > 0 ? [...new Set(createDependsOnIssueIds)] : undefined;
      const res = await fetch('/api/workflows/tasks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: createProjectId,
          sprintId,
          title: createTitle.trim(),
          ...(dependsOnIssueIds?.length ? { dependsOnIssueIds } : {}),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setCreateTitle('');
      setCreateDependsOnIssueIds([]);
      setCreateDepsDropdownOpen(false);
      await load();
      await loadDependencyPickerTasks(createProjectId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function openAssignModal(task: TaskSession) {
    setAssignModalTask(task);
    setModalHandoff('');
    setModalAssignMode('auto');
    setModalAssigneeOptionValue('');
    setLaneMembersByKind(null);
    setError(null);
  }

  function openBulkAssignModal() {
    setBulkAssignOpen(true);
    setBulkSelectedTaskIds([]);
    setBulkHandoff('');
    setBulkAssignMode('auto');
    setBulkAssigneeOptionValue('');
    setBulkLaneMembersByKind(null);
    setError(null);
  }

  function toggleBulkTask(taskId: string) {
    setBulkSelectedTaskIds((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId],
    );
  }

  function toggleBulkSelectAll() {
    const allIds = todoColumnTasks.map((t) => t.id);
    setBulkSelectedTaskIds((prev) => (prev.length === allIds.length ? [] : allIds));
  }

  function openBulkCloseModal() {
    setBulkCloseOpen(true);
    setBulkCloseSelectedTaskIds([]);
    setError(null);
  }

  function toggleBulkCloseTask(taskId: string) {
    setBulkCloseSelectedTaskIds((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId],
    );
  }

  function toggleBulkCloseSelectAll() {
    const allIds = pendingReleaseColumnTasks.map((t) => t.id);
    setBulkCloseSelectedTaskIds((prev) => (prev.length === allIds.length ? [] : allIds));
  }

  async function confirmBulkCloseFromPendingRelease() {
    const selected = pendingReleaseColumnTasks.filter((t) => bulkCloseSelectedTaskIds.includes(t.id));
    if (selected.length === 0) {
      setError('请至少勾选一个任务');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const task of selected) {
        const res = await fetch(`/api/workflows/tasks/${encodeURIComponent(task.id)}/close`, {
          method: 'POST',
        });
        if (!res.ok) throw new Error(await res.text());
      }
      setBulkCloseOpen(false);
      setBulkCloseSelectedTaskIds([]);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openTaskDetail(task: TaskSession) {
    setTaskDetailLoading(true);
    setTaskDetailModal(null);
    setTaskDetailSprint(null);
    setTaskDetailMembers(null);
    setTaskDetailTab('overview');
    setDetailCommentText('');
    setDetailCommentRole('');
    setError(null);
    try {
      const [taskRes, rolesRes, sprintRes] = await Promise.all([
        fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { cache: 'no-store' }),
        fetch(`/api/projects/${encodeURIComponent(task.projectId)}/kanban-roles`, { cache: 'no-store' }),
        fetch(`/api/sprints/${encodeURIComponent(task.sprintId)}`, { cache: 'no-store' }),
      ]);
      if (!taskRes.ok) throw new Error(await taskRes.text());
      const full = (await taskRes.json()) as TaskSession;
      if (rolesRes.ok) {
        const data = (await rolesRes.json()) as { members?: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> };
        setTaskDetailMembers(data.members ?? {});
      } else {
        setTaskDetailMembers({});
      }
      if (sprintRes.ok) {
        setTaskDetailSprint((await sprintRes.json()) as Sprint);
      }
      setTaskDetailModal(full);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setTaskDetailLoading(false);
    }
  }

  function closeTaskDetailModal() {
    setTaskDetailModal(null);
    setTaskDetailSprint(null);
    setTaskDetailMembers(null);
    setTaskDetailTab('overview');
    setDetailCommentText('');
    setDetailCommentRole('');
  }

  async function submitTaskDetailComment() {
    if (!taskDetailModal) return;
    const text = detailCommentText.trim();
    if (!text) {
      setError('请输入备注内容');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${encodeURIComponent(taskDetailModal.id)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: text,
          ...(detailCommentRole ? { role: detailCommentRole } : {}),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const t = (await res.json()) as TaskSession;
      setTaskDetailModal(t);
      setDetailCommentText('');
      setDetailCommentRole('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function workflowStateLabel(state: TaskWorkflowState): string {
    return COLUMNS.find((c) => c.key === state)?.label ?? state;
  }

  useEffect(() => {
    const task = assignModalTask;
    if (!task) {
      setLaneMembersByKind(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(task.projectId)}/kanban-roles`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as { members?: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> };
        if (!cancelled) setLaneMembersByKind(data.members ?? {});
      } catch {
        if (!cancelled) setLaneMembersByKind({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignModalTask]);

  useEffect(() => {
    if (!bulkAssignOpen || !bulkAssignProjectIdForRoles) {
      setBulkLaneMembersByKind(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(bulkAssignProjectIdForRoles)}/kanban-roles`,
          { cache: 'no-store' },
        );
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as { members?: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> };
        if (!cancelled) setBulkLaneMembersByKind(data.members ?? {});
      } catch {
        if (!cancelled) setBulkLaneMembersByKind({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bulkAssignOpen, bulkAssignProjectIdForRoles]);

  async function confirmBulkAssignFromTodo() {
    const selected = todoColumnTasks.filter((t) => bulkSelectedTaskIds.includes(t.id));
    if (selected.length === 0) {
      setError('请至少勾选一个任务');
      return;
    }
    const projectIds = new Set(selected.map((t) => t.projectId));
    if (projectIds.size > 1) {
      setError('批量分配仅支持同一项目内的任务，请取消勾选其他项目的卡片或先筛选项目');
      return;
    }
    if (bulkAssignMode === 'manual' && bulkModalTodoAssignOptions.length > 0 && !bulkAssigneeOptionValue.trim()) {
      setError('已选择「指定人员」时请选择一个负责人');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      for (const task of selected) {
        let kanbanAgent: KanbanAgentKind = inferKanbanAgentForTodoAuto(task);
        let assigneeMemberId: string | undefined;
        if (bulkModalTodoAssignOptions.length > 0 && bulkAssignMode === 'manual') {
          const parsed = parseTodoAssigneeOptionValue(bulkAssigneeOptionValue.trim());
          if (!parsed) {
            setError('请选择一个负责人');
            setBusy(false);
            return;
          }
          kanbanAgent = parsed.kind;
          assigneeMemberId = parsed.memberId;
        }
        const res = await fetch('/api/workflows/tasks/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectId: task.projectId,
            sprintId: task.sprintId,
            issueId: task.issueId,
            taskSessionId: task.id,
            kanbanAgent,
            handoffComment: bulkHandoff.trim() || undefined,
            assigneeMemberId,
            autoAssign: bulkAssignMode === 'auto',
          }),
        });
        if (!res.ok) throw new Error(await res.text());
      }
      setBulkAssignOpen(false);
      setBulkSelectedTaskIds([]);
      setBulkHandoff('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmAssignFromTodo() {
    const task = assignModalTask;
    if (!task) return;
    if (modalAssignMode === 'manual' && modalTodoAssignOptions.length > 0 && !modalAssigneeOptionValue.trim()) {
      setError('已选择「指定人员」时请选择一个负责人');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let kanbanAgent: KanbanAgentKind = inferKanbanAgentForTodoAuto(task);
      let assigneeMemberId: string | undefined;

      if (modalTodoAssignOptions.length > 0 && modalAssignMode === 'manual') {
        const parsed = parseTodoAssigneeOptionValue(modalAssigneeOptionValue.trim());
        if (!parsed) {
          setError('请选择一个负责人');
          setBusy(false);
          return;
        }
        kanbanAgent = parsed.kind;
        assigneeMemberId = parsed.memberId;
      }

      const res = await fetch('/api/workflows/tasks/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: task.projectId,
          sprintId: task.sprintId,
          issueId: task.issueId,
          taskSessionId: task.id,
          kanbanAgent,
          handoffComment: modalHandoff.trim() || undefined,
          assigneeMemberId,
          autoAssign: modalAssignMode === 'auto',
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setAssignModalTask(null);
      setModalHandoff('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadKanbanStatus() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/kanban/status');
      if (!res.ok) throw new Error(await res.text());
      setKanbanStatus((await res.json()) as KanbanStatus);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTaskApi(task: TaskSession) {
    if (!window.confirm(`确定删除任务「${task.issueId}」？此操作不可恢复。`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitManualQueue() {
    if (!manualModalTask) return;
    const text = manualQueueText.trim();
    if (!text) {
      setError('请输入要入队的消息');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workflows/tasks/${encodeURIComponent(manualModalTask.id)}/queue-message`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: text }),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errBody?.error ?? (await res.text()));
      }
      setManualModalTask(null);
      setManualQueueText('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function formatResponsibleAgent(task: TaskSession): string {
    if (task.workflowState === 'pending_start') {
      const lane = task.kanbanAgent ? KANBAN_AGENT_LABELS[task.kanbanAgent] : '—';
      // const deps = task.dependsOnIssueIds?.length
      //   ? ` · 依赖: ${task.dependsOnIssueIds.join(', ')}`
      //   : '';
      const deps = '';
      return `队列中 · ${lane}${deps}`;
    }
    if (task.workflowState === 'todo' && !task.kanbanAgent) {
      return '未分配';
    }
    const lane = task.kanbanAgent ? KANBAN_AGENT_LABELS[task.kanbanAgent] : '—';
    const role = ROLE_LABELS[task.role] ?? task.role;
    return `${lane} · ${role}`;
  }

  function projectLabel(projectId: string): string {
    return projects.find((p) => p.id === projectId)?.name ?? projectId;
  }

  function canManualAdvance(task: TaskSession): boolean {
    return (
      task.workflowState !== 'todo' &&
      task.workflowState !== 'pending_start' &&
      task.workflowState !== 'pending_release' &&
      task.workflowState !== 'closed'
    );
  }

  const manualModalTaskLive = manualModalTask
    ? tasks.find((t) => t.id === manualModalTask.id) ?? manualModalTask
    : null;
  const manualModalGenerating = !!manualModalTaskLive?.agentGenerating;

  const taskDetailWorkflowEntries = useMemo(() => {
    if (!taskDetailModal) return [];
    return sortConversationEntries(taskDetailModal.conversationHistory).filter((e) => e.source === 'workflow');
  }, [taskDetailModal]);

  const taskDetailRoleEntries = useMemo(() => {
    if (!taskDetailModal) {
      return { developer: [] as TaskConversationEntry[], reviewer: [] as TaskConversationEntry[], tester: [] as TaskConversationEntry[] };
    }
    const sorted = sortConversationEntries(taskDetailModal.conversationHistory);
    return {
      developer: sorted.filter((e) => e.role === 'assistant' && e.source === 'developer'),
      reviewer: sorted.filter((e) => e.role === 'assistant' && e.source === 'reviewer'),
      tester: sorted.filter((e) => e.role === 'assistant' && e.source === 'tester'),
    };
  }, [taskDetailModal]);

  const taskDetailUserQueueEntries = useMemo(() => {
    if (!taskDetailModal) return [];
    return sortConversationEntries(taskDetailModal.conversationHistory).filter((e) => e.role === 'user');
  }, [taskDetailModal]);

  const taskDetailHistorySorted = useMemo(() => {
    if (!taskDetailModal?.historyComments?.length) return [];
    return [...taskDetailModal.historyComments].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }, [taskDetailModal]);

  return (
    <main className="page-shell ui-board ui-board-fluid">
      <header className="ui-admin-header">
        <p className="eyebrow">任务</p>
        <h1>Local Kanban</h1>
        <p className="lead ui-muted">
          列：
          <code>
            todo → 队列(pending_start) → in_progress → review → testing → regression_testing → pending_release →
            closed
          </code>
          。从待办分配后先入队；服务端会按顺序扫描队列，依赖满足即可开始开发（可多卡并行），被依赖卡住的项仍留在队列直至上游就绪。
          <strong>点击卡片标题</strong>查看任务详情（分配快照、工作流记录、各角色发言）；待办卡片点「领取」分配任务。<strong>活跃列</strong>可「手动推进」（向当前 lane 入队用户消息）。自动推进失败时由 <code>system_check</code> 循环确认，上限{' '}
          <code>CTI_KANBAN_CONFIRMATION_MAX_LOOPS</code>（默认 100）。提交评审、PR、测试/回归、关单等仍由各 lane agent 调 API 完成。
        </p>
        <p className="lead ui-muted" style={{ marginTop: '0.75rem' }}>
          Telegram：<code>CTI_KANBAN_TELEGRAM_*</code>；worktree：<code>CTI_KANBAN_USE_WORKTREE=1</code>。Slave goal 与 <code>CTI_SLAVE_REPORT_GOAL</code> 等同原说明。
        </p>
        <nav className="ui-nav">
          <a href="/">首页</a>
          <a href="/projects">项目管理</a>
          <a href="/board/roles">角色与 Runner</a>
          <a href="/board/monitor">Agent 监控</a>
          <a href="/admin">管理后台</a>
          <button type="button" className="ui-btn ghost" disabled={busy} onClick={() => void load()}>
            刷新任务
          </button>
          <button type="button" className="ui-btn ghost" disabled={busy} onClick={() => void loadKanbanStatus()}>
            负责人视图（聚合状态）
          </button>
        </nav>
      </header>

      {error ? <p className="ui-banner">{error}</p> : null}

      {kanbanStatus ? (
        <section className="ui-panel" style={{ marginBottom: '1.5rem' }}>
          <h2 className="ui-h2">项目与任务计数</h2>
          <p className="ui-muted">
            待办 {kanbanStatus.tasksByState.todo} · 队列 {kanbanStatus.tasksByState.pending_start ?? 0} · 开发中{' '}
            {kanbanStatus.tasksByState.in_progress} · 评审 {kanbanStatus.tasksByState.review} · 测试{' '}
            {kanbanStatus.tasksByState.testing} · 回归 {kanbanStatus.tasksByState.regression_testing} · 合并主干{' '}
            {kanbanStatus.tasksByState.pending_release} · 完成{' '}
            {kanbanStatus.tasksByState.closed}
          </p>
          <p className="ui-muted">运行中实例数：{kanbanStatus.instances.length}</p>
          <ul className="ui-list">
            {kanbanStatus.tasksByProject && kanbanStatus.tasksByProject.length > 0
              ? kanbanStatus.tasksByProject.map((row) => (
                  <li key={row.projectId}>
                    <strong>{row.name}</strong>
                    {row.owner ? <span className="ui-muted"> — 负责人 {row.owner}</span> : null}
                    <span className="ui-muted" style={{ display: 'block', marginTop: '0.25rem' }}>
                      待办 {row.tasksByState.todo} · 队列 {row.tasksByState.pending_start ?? 0} · 开发中{' '}
                      {row.tasksByState.in_progress} · 评审 {row.tasksByState.review} · 测试 {row.tasksByState.testing} · 回归{' '}
                      {row.tasksByState.regression_testing} · 合并主干 {row.tasksByState.pending_release} · 完成{' '}
                      {row.tasksByState.closed}
                    </span>
                  </li>
                ))
              : kanbanStatus.projects.map((p) => (
                  <li key={p.id}>
                    <strong>{p.name}</strong>
                    {p.owner ? <span className="ui-muted"> — 负责人 {p.owner}</span> : null}
                  </li>
                ))}
          </ul>
        </section>
      ) : null}

      <section className="ui-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 className="ui-h2">看板筛选</h2>
        <p className="ui-muted ui-small" style={{ marginBottom: '0.75rem' }}>
          仅影响上方任务列显示；与下方「新建任务 / 迭代」独立。选「全部项目」可一次查看所有任务。
        </p>
        <label>
          筛选项目
          <select
            className="ui-input"
            style={{ maxWidth: '420px' }}
            value={filterProjectId}
            onChange={(e) => setFilterProjectId(e.target.value)}
          >
            <option value="">全部项目</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section className="ui-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 className="ui-h2">迭代（Sprint）</h2>
        <p className="ui-muted ui-small" style={{ marginBottom: '0.75rem' }}>
          先选项目，再开启迭代（会在仓库中创建 <code>feature/&lt;名称&gt;</code> 分支）。无迭代时无法新建任务。也可在{' '}
          <a href="/projects">项目管理</a> 中维护仓库路径与分支前缀。
        </p>
        <div className="ui-form-row" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
          <label>
            项目
            <select
              className="ui-input"
              value={createProjectId}
              onChange={(e) => {
                setCreateProjectId(e.target.value);
                setSprintId('');
                setCreateDependsOnIssueIds([]);
                setCreateDepsDropdownOpen(false);
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            新迭代名称
            <input
              className="ui-input"
              value={newSprintName}
              onChange={(e) => setNewSprintName(e.target.value)}
              placeholder="例如 Sprint Alpha"
            />
          </label>
          <button type="button" className="ui-btn secondary" disabled={busy || !projects.length} onClick={() => void startSprint()}>
            开启迭代
          </button>
        </div>
        {createProjectId && sprints.length > 0 ? (
          <ul className="ui-list" style={{ marginTop: '1rem' }}>
            {sprints.map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong> — <span className="ui-mono">{s.branchName}</span>
              </li>
            ))}
          </ul>
        ) : createProjectId ? (
          <p className="ui-muted" style={{ marginTop: '0.75rem' }}>
            当前项目尚无迭代，请填写名称并点击「开启迭代」。
          </p>
        ) : null}
      </section>

      <section className="ui-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 className="ui-h2">新建任务（进入待办）</h2>
        <p className="ui-muted ui-small" style={{ marginBottom: '0.75rem' }}>
          Issue ID 由服务端按项目自动生成（格式 <code>前缀-序号</code>）。前缀默认取项目 ID 的第一段（如 <code>demo-app</code> →{' '}
          <code>DEMO</code>），可在 <a href="/projects">项目管理</a> 中设置「Issue 前缀」覆盖。
          {nextIssueHint ? (
            <>
              {' '}
              下一则预计为：<strong className="ui-mono">{nextIssueHint}</strong>。
            </>
          ) : null}
        </p>
        <div className="ui-form-row" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
          <label>
            项目
            <select
              className="ui-input"
              value={createProjectId}
              onChange={(e) => {
                setCreateProjectId(e.target.value);
                setSprintId('');
                setCreateDependsOnIssueIds([]);
                setCreateDepsDropdownOpen(false);
              }}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            迭代
            <select className="ui-input" value={sprintId} onChange={(e) => setSprintId(e.target.value)}>
              <option value="">选择迭代</option>
              {sprints.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.branchName})
                </option>
              ))}
            </select>
          </label>
          <label>
            标题
            <input
              className="ui-input"
              value={createTitle}
              onChange={(e) => setCreateTitle(e.target.value)}
              placeholder="任务描述"
            />
          </label>
          <div className="ui-board-deps-label">
            <span className="ui-board-deps-heading">依赖 Issue（可选，下拉多选）</span>
            <div className="ui-deps-dropdown" ref={createDepsDropdownRef}>
              <button
                type="button"
                className="ui-input ui-deps-dropdown-trigger"
                disabled={!createProjectId || createDependencyOptions.length === 0}
                aria-expanded={createDepsDropdownOpen}
                aria-haspopup="listbox"
                onClick={() => setCreateDepsDropdownOpen((o) => !o)}
              >
                <span className="ui-deps-dropdown-trigger-text">{createDepsTriggerLabel}</span>
                <span className="ui-deps-dropdown-chevron" aria-hidden>
                  {createDepsDropdownOpen ? '▲' : '▼'}
                </span>
              </button>
              {createDepsDropdownOpen && createDependencyOptions.length > 0 ? (
                <div className="ui-deps-dropdown-panel" role="listbox" aria-multiselectable>
                  {createDependencyOptions.map((t) => {
                    const checked = createDependsOnIssueIds.includes(t.issueId);
                    return (
                      <label key={t.id} className="ui-deps-dropdown-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleCreateDepIssue(t.issueId)}
                        />
                        <span className="ui-mono">{t.issueId}</span>
                        <span className="ui-deps-dropdown-title">{t.title}</span>
                      </label>
                    );
                  })}
                </div>
              ) : null}
            </div>
            {/* <span className="ui-muted ui-small" style={{ display: 'block', marginTop: 4 }}>
              {createProjectId && createDependencyOptions.length === 0
                ? '当前项目尚无任务；创建首个任务后，后续任务可依赖已存在的 Issue。'
                : '点击展开下拉，勾选若干 Issue。'}
            </span> */}
          </div>
          <button type="button" className="ui-btn" disabled={busy || !projects.length} onClick={() => void createTask()}>
            创建
          </button>
        </div>
      </section>

      {loading ? (
        <p className="ui-muted">加载任务中…</p>
      ) : (
        <div className="ui-kanban">
          {COLUMNS.map((col) => (
            <section key={col.key} className="ui-column">
              <h2>
                <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {col.label}
                  {col.key === 'todo' ? (
                    <button
                      type="button"
                      className="ui-btn ghost ui-btn-tiny"
                      disabled={busy || (byColumn.get('todo') ?? []).length === 0}
                      onClick={() => openBulkAssignModal()}
                    >
                      批量领取
                    </button>
                  ) : null}
                  {col.key === 'pending_release' ? (
                    <button
                      type="button"
                      className="ui-btn ghost ui-btn-tiny"
                      disabled={busy || (byColumn.get('pending_release') ?? []).length === 0}
                      onClick={() => openBulkCloseModal()}
                    >
                      批量完成
                    </button>
                  ) : null}
                </span>
                <span className="ui-count">{byColumn.get(col.key)?.length ?? 0}</span>
              </h2>
              <div className="ui-cards">
                {(byColumn.get(col.key) ?? []).map((task) => (
                  <article key={task.id} className="ui-card ui-card-kanban">
                    <div className="ui-card-kanban-main">
                      <button
                        type="button"
                        className="ui-card-title-btn"
                        onClick={() => void openTaskDetail(task)}
                      >
                        {task.title}
                      </button>
                      {task.dependsOnIssueIds?.length ? (
                        <p className="ui-card-meta ui-muted">依赖: {task.dependsOnIssueIds.join(', ')}</p>
                      ) : null}
                      {task.agentGenerating ? (
                        <p className="ui-card-meta" style={{ color: 'var(--ui-accent, #38bdf8)' }}>
                          Agent 正在生成回复…
                        </p>
                      ) : null}
                      <p className="ui-card-meta ui-muted">项目：{projectLabel(task.projectId)}</p>
                      <p className="ui-card-meta ui-card-kanban-agent">负责：{formatResponsibleAgent(task)}</p>
                    </div>
                    <div className="ui-card-kanban-toolbar">
                      {task.workflowState === 'todo' ? (
                        <button
                          type="button"
                          className="ui-btn ghost ui-btn-tiny"
                          disabled={busy}
                          onClick={() => openAssignModal(task)}
                        >
                          领取
                        </button>
                      ) : null}
                      {canManualAdvance(task) ? (
                        <button
                          type="button"
                          className="ui-btn ghost ui-btn-tiny"
                          disabled={busy || !!task.agentGenerating}
                          title={task.agentGenerating ? 'Agent 正在生成回复，请稍后再手动推进' : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            setManualModalTask(task);
                            setManualQueueText('');
                          }}
                        >
                          手动推进
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="ui-btn ghost ui-btn-tiny"
                        disabled={busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteTaskApi(task);
                        }}
                      >
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {assignModalTask ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            background: 'rgba(2, 6, 23, 0.72)',
          }}
          onClick={() => setAssignModalTask(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="assign-modal-title"
            className="ui-panel"
            style={{ maxWidth: 440, width: '100%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="assign-modal-title" className="ui-h2" style={{ marginTop: 0 }}>
              从待办分配：{assignModalTask.issueId}
            </h2>
            <p className="ui-muted ui-small" style={{ marginBottom: '1rem' }}>
              负责人决定谁来做，并对应其所在开发 lane（<code>agent-开发</code> / <code>codex-高级开发</code>）与
              runner。<strong>自动分配</strong>时：评审打回次数<strong>大于 2</strong>（第 3 次及以后打回再开发）固定走高级开发 lane，否则走普通开发。
              评审与测试 lane 由后续步骤自动挂载。
            </p>
            {modalTodoAssignOptions.length > 0 ? (
              <div style={{ marginTop: '0.75rem' }}>
                <p className="ui-muted ui-small" style={{ marginBottom: '0.35rem' }}>
                  分配方式（已配置多名人员时）
                </p>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                  <input
                    type="radio"
                    name="assign-mode"
                    checked={modalAssignMode === 'auto'}
                    onChange={() => setModalAssignMode('auto')}
                  />
                  自动（按对应 lane：历史上该任务该 lane 给谁则继续给谁；否则给当前负载最少的人）
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <input
                    type="radio"
                    name="assign-mode"
                    checked={modalAssignMode === 'manual'}
                    onChange={() => setModalAssignMode('manual')}
                  />
                  指定负责人
                </label>
                {modalAssignMode === 'manual' ? (
                  <select
                    className="ui-input"
                    style={{ width: '100%', marginTop: '0.5rem' }}
                    value={modalAssigneeOptionValue}
                    onChange={(e) => setModalAssigneeOptionValue(e.target.value)}
                  >
                    <option value="">选择负责人</option>
                    {modalTodoAssignOptions.map(({ kind, member }) => (
                      <option key={`${kind}:${member.id}`} value={todoAssigneeOptionValue(kind, member.id)}>
                        {(member.name || member.id).trim()} · {KANBAN_AGENT_LABELS[kind]}
                      </option>
                    ))}
                  </select>
                ) : null}
              </div>
            ) : laneMembersByKind !== null ? (
              <p className="ui-muted ui-small" style={{ marginTop: '0.75rem' }}>
                该项目未在「角色与 Runner」配置负责人列表；将使用默认开发 lane（agent-开发）与默认 runner。
              </p>
            ) : (
              <p className="ui-muted ui-small" style={{ marginTop: '0.75rem' }}>
                正在加载人员配置…
              </p>
            )}
            <label style={{ display: 'block', marginTop: '0.75rem' }}>
              交接说明（可选，有内容时会写入工作流 comment）
              <textarea
                className="ui-input"
                style={{ width: '100%', minHeight: 88, marginTop: 4 }}
                value={modalHandoff}
                onChange={(e) => setModalHandoff(e.target.value)}
                placeholder="需要时填写；留空则仅按 lane 分配并启动"
              />
            </label>
            <div className="ui-actions-bar" style={{ marginTop: '1.25rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button type="button" className="ui-btn ghost" disabled={busy} onClick={() => setAssignModalTask(null)}>
                取消
              </button>
              <button type="button" className="ui-btn primary" disabled={busy} onClick={() => void confirmAssignFromTodo()}>
                分配并启动 runner
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {bulkAssignOpen ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 201,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            background: 'rgba(2, 6, 23, 0.72)',
          }}
          onClick={() => setBulkAssignOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-assign-modal-title"
            className="ui-panel"
            style={{ maxWidth: 520, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="bulk-assign-modal-title" className="ui-h2" style={{ marginTop: 0, flexShrink: 0 }}>
              批量领取（待办）
            </h2>
            <p className="ui-muted ui-small" style={{ marginBottom: '0.75rem' }}>
              勾选同一项目下的任务，选择分配方式后统一分配并启动 runner。
            </p>
            <div
              className="ui-bulk-task-list"
              style={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                border: '1px solid rgba(148, 163, 184, 0.25)',
                borderRadius: 10,
                padding: '8px 10px',
                marginBottom: '0.75rem',
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  padding: '6px 0',
                  borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
                  marginBottom: 6,
                  cursor: todoColumnTasks.length ? 'pointer' : 'default',
                }}
              >
                <input
                  type="checkbox"
                  checked={
                    todoColumnTasks.length > 0 && bulkSelectedTaskIds.length === todoColumnTasks.length
                  }
                  disabled={!todoColumnTasks.length || busy}
                  onChange={() => toggleBulkSelectAll()}
                />
                <span style={{ fontWeight: 600 }}>全选</span>
              </label>
              {todoColumnTasks.length === 0 ? (
                <p className="ui-muted ui-small" style={{ margin: '8px 0 0' }}>
                  当前待办列为空。
                </p>
              ) : (
                todoColumnTasks.map((task) => (
                  <label
                    key={task.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                      padding: '8px 0',
                      borderBottom: '1px solid rgba(148, 163, 184, 0.12)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={bulkSelectedTaskIds.includes(task.id)}
                      disabled={busy}
                      onChange={() => toggleBulkTask(task.id)}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="ui-mono" style={{ fontSize: 12 }}>
                        {task.issueId}
                      </span>
                      <span style={{ display: 'block', marginTop: 2 }}>{task.title}</span>
                      <span className="ui-muted ui-small" style={{ display: 'block', marginTop: 4 }}>
                        {projectLabel(task.projectId)}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>

            {bulkSelectedSpansMultipleProjects ? (
              <p className="ui-small" style={{ margin: '0 0 0.75rem', color: '#fbbf24' }}>
                已选任务属于多个项目。请只勾选同一项目的任务，或先在顶部筛选项目后再批量领取。
              </p>
            ) : null}

            {bulkSelectedTaskIds.length > 0 && !bulkSelectedSpansMultipleProjects ? (
              <>
                <p className="ui-muted ui-small" style={{ marginBottom: '0.35rem' }}>
                  分配方式（开发 lane）
                </p>
                {bulkModalTodoAssignOptions.length > 0 ? (
                  <div style={{ marginTop: '0.35rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
                      <input
                        type="radio"
                        name="bulk-assign-mode"
                        checked={bulkAssignMode === 'auto'}
                        onChange={() => setBulkAssignMode('auto')}
                      />
                      自动（按 lane 与负载；打回次数 {'>'} 2 时用高级开发 lane）
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <input
                        type="radio"
                        name="bulk-assign-mode"
                        checked={bulkAssignMode === 'manual'}
                        onChange={() => setBulkAssignMode('manual')}
                      />
                      指定负责人
                    </label>
                    {bulkAssignMode === 'manual' ? (
                      <select
                        className="ui-input"
                        style={{ width: '100%', marginTop: '0.5rem' }}
                        value={bulkAssigneeOptionValue}
                        onChange={(e) => setBulkAssigneeOptionValue(e.target.value)}
                      >
                        <option value="">选择负责人</option>
                        {bulkModalTodoAssignOptions.map(({ kind, member }) => (
                          <option key={`${kind}:${member.id}`} value={todoAssigneeOptionValue(kind, member.id)}>
                            {(member.name || member.id).trim()} · {KANBAN_AGENT_LABELS[kind]}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </div>
                ) : bulkLaneMembersByKind !== null ? (
                  <p className="ui-muted ui-small" style={{ marginTop: '0.35rem' }}>
                    该项目未配置负责人列表；将使用默认 agent-开发 lane 与默认 runner。
                  </p>
                ) : (
                  <p className="ui-muted ui-small" style={{ marginTop: '0.35rem' }}>
                    正在加载人员配置…
                  </p>
                )}
                <label style={{ display: 'block', marginTop: '0.75rem' }}>
                  交接说明（可选，将写入每个任务的工作流 comment）
                  <textarea
                    className="ui-input"
                    style={{ width: '100%', minHeight: 72, marginTop: 4 }}
                    value={bulkHandoff}
                    onChange={(e) => setBulkHandoff(e.target.value)}
                    placeholder="需要时填写；留空则仅按 lane 分配并启动"
                  />
                </label>
              </>
            ) : (
              <p className="ui-muted ui-small" style={{ margin: '0 0 0.75rem' }}>
                勾选任务后将显示分配方式。
              </p>
            )}

            <div className="ui-actions-bar" style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button type="button" className="ui-btn ghost" disabled={busy} onClick={() => setBulkAssignOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="ui-btn primary"
                disabled={
                  busy ||
                  bulkSelectedTaskIds.length === 0 ||
                  bulkSelectedSpansMultipleProjects
                }
                onClick={() => void confirmBulkAssignFromTodo()}
              >
                分配并启动 runner
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {bulkCloseOpen ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 201,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            background: 'rgba(2, 6, 23, 0.72)',
          }}
          onClick={() => setBulkCloseOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-close-modal-title"
            className="ui-panel"
            style={{ maxWidth: 520, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="bulk-close-modal-title" className="ui-h2" style={{ marginTop: 0, flexShrink: 0 }}>
              批量标记完成（合并主干）
            </h2>
            <p className="ui-muted ui-small" style={{ marginBottom: '0.75rem' }}>
              勾选「合并主干」列中的任务，将依次调用关单（与单卡标记完成相同：必要时确保 release PR 等）。
            </p>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                border: '1px solid rgba(148, 163, 184, 0.25)',
                borderRadius: 10,
                padding: '8px 10px',
                marginBottom: '0.75rem',
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: '0.5rem',
                  padding: '6px 0',
                  borderBottom: '1px solid rgba(148, 163, 184, 0.2)',
                  marginBottom: 6,
                  cursor: pendingReleaseColumnTasks.length ? 'pointer' : 'default',
                }}
              >
                <input
                  type="checkbox"
                  checked={
                    pendingReleaseColumnTasks.length > 0 &&
                    bulkCloseSelectedTaskIds.length === pendingReleaseColumnTasks.length
                  }
                  disabled={!pendingReleaseColumnTasks.length || busy}
                  onChange={() => toggleBulkCloseSelectAll()}
                />
                <span style={{ fontWeight: 600 }}>全选</span>
              </label>
              {pendingReleaseColumnTasks.length === 0 ? (
                <p className="ui-muted ui-small" style={{ margin: '8px 0 0' }}>
                  当前「合并主干」列为空。
                </p>
              ) : (
                pendingReleaseColumnTasks.map((task) => (
                  <label
                    key={task.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.5rem',
                      padding: '8px 0',
                      borderBottom: '1px solid rgba(148, 163, 184, 0.12)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={bulkCloseSelectedTaskIds.includes(task.id)}
                      disabled={busy}
                      onChange={() => toggleBulkCloseTask(task.id)}
                    />
                    <span style={{ flex: 1, minWidth: 0 }}>
                      <span className="ui-mono" style={{ fontSize: 12 }}>
                        {task.issueId}
                      </span>
                      <span style={{ display: 'block', marginTop: 2 }}>{task.title}</span>
                      <span className="ui-muted ui-small" style={{ display: 'block', marginTop: 4 }}>
                        {projectLabel(task.projectId)}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>
            <div className="ui-actions-bar" style={{ marginTop: '0.25rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button type="button" className="ui-btn ghost" disabled={busy} onClick={() => setBulkCloseOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="ui-btn primary"
                disabled={busy || bulkCloseSelectedTaskIds.length === 0}
                onClick={() => void confirmBulkCloseFromPendingRelease()}
              >
                标记为完成
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {taskDetailLoading && !taskDetailModal ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 205,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            background: 'rgba(2, 6, 23, 0.72)',
          }}
        >
          <p className="ui-muted" style={{ fontSize: 15 }}>
            加载任务详情…
          </p>
        </div>
      ) : null}

      {taskDetailModal ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 210,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            background: 'rgba(2, 6, 23, 0.72)',
          }}
          onClick={() => closeTaskDetailModal()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-detail-modal-title"
            className="ui-panel"
            style={{ maxWidth: 720, width: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="task-detail-modal-title" className="ui-h2" style={{ marginTop: 0, flexShrink: 0 }}>
              {taskDetailModal.issueId} · {taskDetailModal.title}
            </h2>
            <div className="ui-tab-row" role="tablist" style={{ flexShrink: 0, marginBottom: '0.75rem' }}>
              {(
                [
                  { id: 'overview' as const, label: '概览' },
                  { id: 'history' as const, label: '交接记录' },
                  { id: 'dialog' as const, label: '对话与日志' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={taskDetailTab === tab.id}
                  className={`ui-tab ${taskDetailTab === tab.id ? 'ui-tab-active' : ''}`}
                  onClick={() => setTaskDetailTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <div className="ui-task-detail-scroll" style={{ flex: 1, minHeight: 0 }}>
              {taskDetailTab === 'overview' ? (
                <>
                  <dl style={{ margin: 0, display: 'grid', gap: '0.35rem 1rem', fontSize: 13 }}>
                    <dt className="ui-muted" style={{ margin: 0 }}>
                      状态
                    </dt>
                    <dd style={{ margin: 0 }}>{workflowStateLabel(taskDetailModal.workflowState)}</dd>
                    <dt className="ui-muted" style={{ margin: 0 }}>
                      项目
                    </dt>
                    <dd style={{ margin: 0 }}>{projectLabel(taskDetailModal.projectId)}</dd>
                    <dt className="ui-muted" style={{ margin: 0 }}>
                      迭代
                    </dt>
                    <dd style={{ margin: 0 }}>
                      {taskDetailSprint ? (
                        <>
                          {taskDetailSprint.name}{' '}
                          <span className="ui-mono">({taskDetailSprint.branchName})</span>
                        </>
                      ) : (
                        <span className="ui-mono">{taskDetailModal.sprintId}</span>
                      )}
                    </dd>
                    <dt className="ui-muted" style={{ margin: 0 }}>
                      当前 lane / 角色
                    </dt>
                    <dd style={{ margin: 0 }}>
                      {taskDetailModal.kanbanAgent ? KANBAN_AGENT_LABELS[taskDetailModal.kanbanAgent] : '—'} ·{' '}
                      {ROLE_LABELS[taskDetailModal.role] ?? taskDetailModal.role}
                    </dd>
                    {taskDetailModal.reviewRejectionCount != null && taskDetailModal.reviewRejectionCount > 0 ? (
                      <>
                        <dt className="ui-muted" style={{ margin: 0 }}>
                          评审打回次数
                        </dt>
                        <dd style={{ margin: 0 }}>{taskDetailModal.reviewRejectionCount}</dd>
                      </>
                    ) : null}
                    {taskDetailModal.branchName ? (
                      <>
                        <dt className="ui-muted" style={{ margin: 0 }}>
                          分支
                        </dt>
                        <dd style={{ margin: 0 }} className="ui-mono">
                          {taskDetailModal.branchName}
                        </dd>
                      </>
                    ) : null}
                    {taskDetailModal.worktreePath ? (
                      <>
                        <dt className="ui-muted" style={{ margin: 0 }}>
                          Worktree
                        </dt>
                        <dd style={{ margin: 0 }} className="ui-mono">
                          {taskDetailModal.worktreePath}
                        </dd>
                      </>
                    ) : null}
                    {taskDetailModal.pullRequestUrl ? (
                      <>
                        <dt className="ui-muted" style={{ margin: 0 }}>
                          Pull request
                        </dt>
                        <dd style={{ margin: 0 }}>
                          <a href={taskDetailModal.pullRequestUrl} target="_blank" rel="noreferrer">
                            {taskDetailModal.pullRequestNumber != null
                              ? `#${taskDetailModal.pullRequestNumber}`
                              : taskDetailModal.pullRequestUrl}
                          </a>
                        </dd>
                      </>
                    ) : null}
                    {taskDetailModal.handoffComment ? (
                      <>
                        <dt className="ui-muted" style={{ margin: 0 }}>
                          交接说明
                        </dt>
                        <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{taskDetailModal.handoffComment}</dd>
                      </>
                    ) : null}
                  </dl>

                  <div className="ui-task-detail-block">
                    <h3>当前分配（各 lane 负责人）</h3>
                    {taskDetailModal.kanbanAssignees &&
                    Object.keys(taskDetailModal.kanbanAssignees).length > 0 ? (
                      <ul className="ui-list" style={{ margin: 0, paddingLeft: '1.1rem' }}>
                        {(Object.entries(taskDetailModal.kanbanAssignees) as [KanbanAgentKind, string][]).map(
                          ([kind, id]) => (
                            <li key={kind}>{formatAssigneeCell(kind, id, taskDetailMembers)}</li>
                          ),
                        )}
                      </ul>
                    ) : (
                      <p className="ui-muted ui-small" style={{ margin: 0 }}>
                        尚无按 lane 记录的负责人（领取或跑过 lane 后会写入）。
                      </p>
                    )}
                  </div>
                </>
              ) : null}

              {taskDetailTab === 'history' ? (
                <>
                  <p className="ui-muted ui-small" style={{ margin: '0 0 0.75rem' }}>
                    每次<strong>状态交接</strong>会自动记录 outgoing 角色在本轮的助手摘要；也可手动添加备注。
                  </p>
                  {taskDetailHistorySorted.length > 0 ? (
                    taskDetailHistorySorted.map((c) => (
                      <article key={c.id} className="ui-task-detail-entry">
                        <time dateTime={c.createdAt}>{new Date(c.createdAt).toLocaleString()}</time>
                        <p style={{ margin: '0.15rem 0 0.35rem', fontSize: 12, color: '#94a3b8' }}>
                          {formatHistoryCommentMeta(c, workflowStateLabel)}
                        </p>
                        <pre className="ui-task-detail-pre">{c.content}</pre>
                      </article>
                    ))
                  ) : (
                    <p className="ui-muted ui-small" style={{ margin: 0 }}>
                      暂无交接记录。任务在列之间移动后会自动生成。
                    </p>
                  )}
                  <div className="ui-task-detail-block">
                    <h3>添加备注</h3>
                    <label style={{ display: 'block', fontSize: 13 }}>
                      角色（可选）
                      <select
                        className="ui-input"
                        style={{ width: '100%', marginTop: 4 }}
                        value={detailCommentRole}
                        onChange={(e) => setDetailCommentRole(e.target.value as '' | AgentRole)}
                      >
                        <option value="">不标注</option>
                        <option value="developer">开发</option>
                        <option value="reviewer">评审</option>
                        <option value="tester">测试</option>
                      </select>
                    </label>
                    <label style={{ display: 'block', fontSize: 13, marginTop: '0.65rem' }}>
                      内容
                      <textarea
                        className="ui-input"
                        style={{ width: '100%', minHeight: 88, marginTop: 4 }}
                        value={detailCommentText}
                        onChange={(e) => setDetailCommentText(e.target.value)}
                        placeholder="输入人工备注（写入交接记录）"
                      />
                    </label>
                    <button
                      type="button"
                      className="ui-btn primary"
                      style={{ marginTop: '0.75rem' }}
                      disabled={busy}
                      onClick={() => void submitTaskDetailComment()}
                    >
                      保存备注
                    </button>
                  </div>
                </>
              ) : null}

              {taskDetailTab === 'dialog' ? (
                <>
                  <div className="ui-task-detail-block" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
                    <h3>工作流与分配记录</h3>
                    {taskDetailWorkflowEntries.length > 0 ? (
                      taskDetailWorkflowEntries.map((e) => (
                        <article key={e.id} className="ui-task-detail-entry">
                          <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
                          <pre className="ui-task-detail-pre">{e.content}</pre>
                        </article>
                      ))
                    ) : (
                      <p className="ui-muted ui-small" style={{ margin: 0 }}>
                        暂无工作流记录。
                      </p>
                    )}
                  </div>

                  {taskDetailUserQueueEntries.length > 0 ? (
                    <div className="ui-task-detail-block">
                      <h3>用户与入队消息</h3>
                      {taskDetailUserQueueEntries.map((e) => (
                        <article key={e.id} className="ui-task-detail-entry">
                          <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
                          <p style={{ margin: 0, fontSize: 12, color: '#64748b' }}>来源: {e.source}</p>
                          <pre className="ui-task-detail-pre">{e.content}</pre>
                        </article>
                      ))}
                    </div>
                  ) : null}

                  {(['developer', 'reviewer', 'tester'] as const).map((roleKey) => {
                    const list = taskDetailRoleEntries[roleKey];
                    return (
                      <div key={roleKey} className="ui-task-detail-block">
                        <h3>
                          {ROLE_SOURCE_LABELS[roleKey]}（{roleKey}）
                        </h3>
                        {list.length > 0 ? (
                          list.map((e) => (
                            <article key={e.id} className="ui-task-detail-entry">
                              <time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleString()}</time>
                              <pre className="ui-task-detail-pre">{e.content}</pre>
                            </article>
                          ))
                        ) : (
                          <p className="ui-muted ui-small" style={{ margin: 0 }}>
                            暂无该角色的助手发言。
                          </p>
                        )}
                      </div>
                    );
                  })}
                </>
              ) : null}
            </div>
            <div className="ui-actions-bar" style={{ marginTop: '1rem', flexShrink: 0, display: 'flex', gap: '0.5rem' }}>
              <button type="button" className="ui-btn ghost" onClick={() => closeTaskDetailModal()}>
                关闭
              </button>
              <button
                type="button"
                className="ui-btn secondary"
                disabled={taskDetailLoading}
                onClick={() => void openTaskDetail(taskDetailModal)}
              >
                刷新详情
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {manualModalTask ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 200,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            background: 'rgba(2, 6, 23, 0.72)',
          }}
          onClick={() => {
            setManualModalTask(null);
            setManualQueueText('');
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="manual-queue-modal-title"
            className="ui-panel"
            style={{ maxWidth: 480, width: '100%' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="manual-queue-modal-title" className="ui-h2" style={{ marginTop: 0 }}>
              手动推进：{manualModalTask.issueId}
            </h2>
            <p className="ui-muted ui-small" style={{ marginBottom: '1rem' }}>
              文本将作为 <strong>用户消息</strong> 入队，由当前列（lane）对应的 agent 继续处理。用于补充说明或人工指令。
            </p>
            {manualModalGenerating ? (
              <p className="ui-muted ui-small" style={{ marginBottom: '0.75rem' }}>
                Agent 正在生成回复，请结束后再入队。
              </p>
            ) : null}
            <label style={{ display: 'block' }}>
              消息内容
              <textarea
                className="ui-input"
                style={{ width: '100%', minHeight: 120, marginTop: 4 }}
                value={manualQueueText}
                onChange={(e) => setManualQueueText(e.target.value)}
                placeholder="输入要发送给 agent 的内容"
                autoFocus
              />
            </label>
            <div className="ui-actions-bar" style={{ marginTop: '1.25rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="ui-btn ghost"
                disabled={busy}
                onClick={() => {
                  setManualModalTask(null);
                  setManualQueueText('');
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="ui-btn primary"
                disabled={busy || manualModalGenerating}
                title={manualModalGenerating ? 'Agent 正在生成回复' : undefined}
                onClick={() => void submitManualQueue()}
              >
                入队并继续
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
