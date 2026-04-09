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

/** Order matches pipeline: 开发 → 前置测试 → 功能测试 → PR 评审 → 合并后回归 → 合并主干 → 完成 */
const COLUMNS: { key: TaskWorkflowState; label: string }[] = [
  { key: 'todo', label: '待办' },
  { key: 'pending_start', label: '队列' },
  { key: 'in_progress', label: '开发中' },
  { key: 'pre_testing', label: '前置测试' },
  { key: 'testing', label: '测试中' },
  { key: 'review', label: '评审中' },
  { key: 'regression_testing', label: '回归测试中' },
  { key: 'pending_uat', label: 'UAT' },
  { key: 'pending_release', label: '合并主干' },
  { key: 'blocked', label: '阻塞' },
  { key: 'closed', label: '完成' },
];

const ROLE_LABELS: Record<string, string> = {
  developer: '开发',
  reviewer: '评审',
  tester: '测试',
};

const KANBAN_AGENT_LABELS: Record<KanbanAgentKind, string> = {
  'agent-dev': 'agent-开发',
  'pre-tester': 'pre-tester',
  'claude-review': 'claude-review',
  'copilot-test': 'copilot-测试',
  'codex-senior': 'codex-高级开发',
  'self-host-runner': 'self-host-runner (CI)',
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

/** Agent lanes that must have a non-empty default runner before assign (API `assertProjectDefaultRunnersForAssign`). */
const KANBAN_AGENT_LANES_REQUIRING_DEFAULT: KanbanAgentKind[] = [
  'agent-dev',
  'pre-tester',
  'codex-senior',
  'claude-review',
  'copilot-test',
];

/** Every agent lane needs `kanbanRoleRunners[kind]` set, even if the roster lists members. */
function projectHasAllAgentLaneDefaultRunners(mapping: Partial<Record<KanbanAgentKind, string>> | null): boolean {
  if (!mapping) return false;
  return KANBAN_AGENT_LANES_REQUIRING_DEFAULT.every((k) => Boolean(mapping[k]?.trim()));
}

const ROLE_SOURCE_LABELS: Record<'developer' | 'reviewer' | 'tester', string> = {
  developer: '开发',
  reviewer: '评审',
  tester: '测试',
};

function sortConversationEntries(entries: TaskConversationEntry[]): TaskConversationEntry[] {
  return [...entries].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** 将需求讨论对话整理为「批量创建」batch-spec API 的输入文本 */
function formatBrainstormTranscriptForBatch(
  messages: { role: 'user' | 'assistant'; content: string }[],
): string {
  const parts = messages
    .map((m) => {
      const t = m.content.trim();
      if (!t) return null;
      const label = m.role === 'user' ? '【用户】' : '【高级开发】';
      return `${label}\n${t}`;
    })
    .filter((x): x is string => x !== null);
  if (parts.length === 0) return '';
  const header =
    '以下为需求讨论记录。请据此拆分为可执行的 Kanban 任务并标注依赖关系（后序任务依赖先序任务）。\n\n';
  return header + parts.join('\n\n---\n\n');
}

/** Parse `{ error?: string }` from a failed fetch without consuming the body twice. */
async function errorMessageFromApiResponse(res: Response): Promise<string> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (typeof j.error === 'string' && j.error.trim()) return j.error.trim();
  } catch {
    /* not JSON */
  }
  if (text.trim()) return text.trim();
  return `HTTP ${res.status}`;
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
  const [createIsHotfix, setCreateIsHotfix] = useState(false);
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
  const [bulkAssignKanbanMapping, setBulkAssignKanbanMapping] = useState<
    Partial<Record<KanbanAgentKind, string>> | null
  >(null);
  /** 合并主干列：批量标记完成 */
  const [bulkCloseOpen, setBulkCloseOpen] = useState(false);
  const [bulkCloseSelectedTaskIds, setBulkCloseSelectedTaskIds] = useState<string[]>([]);
  /** 批量创建：粘贴 → 高级开发（codex-senior）生成任务列表 → 写入待办 */
  const [batchCreateOpen, setBatchCreateOpen] = useState(false);
  const [batchCreateText, setBatchCreateText] = useState('');
  const [batchPreviewTasks, setBatchPreviewTasks] = useState<
    { title: string; dependsOnIndices: number[] }[] | null
  >(null);
  const [batchPreviewLoading, setBatchPreviewLoading] = useState(false);
  /** 高级开发：需求讨论（brainstorming + Codex 流式） */
  const [brainstormOpen, setBrainstormOpen] = useState(false);
  const [brainstormSessionId, setBrainstormSessionId] = useState('');
  const [brainstormSdkSessionId, setBrainstormSdkSessionId] = useState<string | null>(null);
  const [brainstormMessages, setBrainstormMessages] = useState<
    { role: 'user' | 'assistant'; content: string }[]
  >([]);
  const [brainstormInput, setBrainstormInput] = useState('');
  const [brainstormStreaming, setBrainstormStreaming] = useState(false);
  /** 待办领取弹窗：当前选中的任务；null 表示关闭 */
  const [assignModalTask, setAssignModalTask] = useState<TaskSession | null>(null);
  const [modalHandoff, setModalHandoff] = useState('');
  /** Loaded when assign modal opens — project kanbanRoleMembers from API */
  const [laneMembersByKind, setLaneMembersByKind] = useState<
    Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> | null
  >(null);
  /** `mapping` from kanban-roles API (`kanbanRoleRunners`); null = not loaded yet */
  const [assignModalKanbanMapping, setAssignModalKanbanMapping] = useState<
    Partial<Record<KanbanAgentKind, string>> | null
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

  /** Avoid stale async writes when filter / sprint / detail target changes quickly. */
  const filterProjectIdRef = useRef(filterProjectId);
  filterProjectIdRef.current = filterProjectId;
  const effectiveProjectIdRef = useRef('');
  const taskDetailLoadGenRef = useRef(0);
  const loadGenRef = useRef(0);
  const assignModalTaskIdRef = useRef<string | null>(null);
  const bulkAssignProjectIdRef = useRef<string | null>(null);

  /** 表单未选项目时退回列表第一项；需求讨论等不必先在表单里点选项目 */
  const effectiveProjectId = useMemo(
    () => (createProjectId.trim() ? createProjectId : projects[0]?.id ?? ''),
    [createProjectId, projects],
  );
  effectiveProjectIdRef.current = effectiveProjectId;
  assignModalTaskIdRef.current = assignModalTask?.id ?? null;

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

  const assignModalCanAssignFromTodo = useMemo(() => {
    if (!assignModalTask || assignModalKanbanMapping === null || laneMembersByKind === null) return false;
    if (modalTodoAssignOptions.length > 0 && modalAssignMode === 'manual') {
      if (!modalAssigneeOptionValue.trim()) return false;
      const parsed = parseTodoAssigneeOptionValue(modalAssigneeOptionValue.trim());
      if (!parsed) return false;
      return projectHasAllAgentLaneDefaultRunners(assignModalKanbanMapping);
    }
    return projectHasAllAgentLaneDefaultRunners(assignModalKanbanMapping);
  }, [
    assignModalTask,
    assignModalKanbanMapping,
    laneMembersByKind,
    modalTodoAssignOptions.length,
    modalAssignMode,
    modalAssigneeOptionValue,
  ]);

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current;
    setLoading(true);
    setError(null);
    try {
      const taskUrl = filterProjectId
        ? `/api/tasks?projectId=${encodeURIComponent(filterProjectId)}`
        : '/api/tasks';
      const [taskRes, projRes] = await Promise.all([fetch(taskUrl), fetch('/api/projects')]);
      if (gen !== loadGenRef.current) return;
      if (!taskRes.ok) throw new Error(await taskRes.text());
      if (!projRes.ok) throw new Error(await projRes.text());
      const taskBody = (await taskRes.json()) as TaskSession[];
      const projBody = (await projRes.json()) as Project[];
      if (gen !== loadGenRef.current) return;
      setTasks(Array.isArray(taskBody) ? taskBody : []);
      setProjects(Array.isArray(projBody) ? projBody : []);
    } catch (e) {
      if (gen === loadGenRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (gen === loadGenRef.current) {
        setLoading(false);
      }
    }
  }, [filterProjectId]);

  const silentRefreshTasks = useCallback(async () => {
    try {
      const snapshot = filterProjectId;
      const taskUrl = filterProjectId
        ? `/api/tasks?projectId=${encodeURIComponent(filterProjectId)}`
        : '/api/tasks';
      const taskRes = await fetch(taskUrl, { cache: 'no-store' });
      if (filterProjectIdRef.current !== snapshot) return;
      if (!taskRes.ok) return;
      const taskBody = (await taskRes.json()) as TaskSession[];
      if (filterProjectIdRef.current !== snapshot) return;
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
      if (effectiveProjectIdRef.current !== pid) return;
      const body = (await res.json()) as Sprint[];
      const list = Array.isArray(body) ? body : [];
      if (effectiveProjectIdRef.current !== pid) return;
      setSprints(list);
      setSprintId((prev) => (list.some((s) => s.id === prev) ? prev : list[0]?.id ?? ''));
    } catch (e) {
      if (effectiveProjectIdRef.current === pid) {
        setError(e instanceof Error ? e.message : String(e));
      }
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
    if (effectiveProjectId) void loadSprints(effectiveProjectId);
  }, [effectiveProjectId, loadSprints]);

  const loadDependencyPickerTasks = useCallback(async (projectId: string) => {
    if (!projectId) {
      setDependencyPickerTasks([]);
      return;
    }
    try {
      const res = await fetch(`/api/tasks?projectId=${encodeURIComponent(projectId)}`, { cache: 'no-store' });
      if (effectiveProjectIdRef.current !== projectId) return;
      if (!res.ok) return;
      const body = (await res.json()) as TaskSession[];
      if (effectiveProjectIdRef.current !== projectId) return;
      setDependencyPickerTasks(Array.isArray(body) ? body : []);
    } catch {
      /* ignore transient errors */
    }
  }, []);

  useEffect(() => {
    void loadDependencyPickerTasks(effectiveProjectId);
  }, [effectiveProjectId, loadDependencyPickerTasks]);

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
      // `closing` tasks are shown inside the pending_release column (with a spinner badge)
      const displayState = t.workflowState === 'closing' ? 'pending_release' : t.workflowState;
      const list = map.get(displayState);
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

  bulkAssignProjectIdRef.current = bulkAssignProjectIdForRoles;

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

  const bulkTodoAssignSelectedTasks = useMemo(
    () => todoColumnTasks.filter((t) => bulkSelectedTaskIds.includes(t.id)),
    [todoColumnTasks, bulkSelectedTaskIds],
  );

  const bulkTodoAssignFromTodoAllowed = useMemo(() => {
    if (bulkLaneMembersByKind === null || bulkAssignKanbanMapping === null) return false;
    if (bulkTodoAssignSelectedTasks.length === 0) return false;
    if (bulkModalTodoAssignOptions.length > 0 && bulkAssignMode === 'manual') {
      if (!bulkAssigneeOptionValue.trim()) return false;
      const parsed = parseTodoAssigneeOptionValue(bulkAssigneeOptionValue.trim());
      if (!parsed) return false;
      return projectHasAllAgentLaneDefaultRunners(bulkAssignKanbanMapping);
    }
    return projectHasAllAgentLaneDefaultRunners(bulkAssignKanbanMapping);
  }, [
    bulkLaneMembersByKind,
    bulkAssignKanbanMapping,
    bulkTodoAssignSelectedTasks,
    bulkModalTodoAssignOptions.length,
    bulkAssignMode,
    bulkAssigneeOptionValue,
  ]);

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
          ...(createIsHotfix ? { isHotfix: true } : {}),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setCreateTitle('');
      setCreateDependsOnIssueIds([]);
      setCreateDepsDropdownOpen(false);
      setCreateIsHotfix(false);
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

  /** 与「批量创建」共用：调用 batch-spec preview API。成功返回 true。 */
  async function runBatchSpecPreviewFromRaw(raw: string): Promise<boolean> {
    if (!effectiveProjectId || !sprintId) {
      setError('请先选择项目与迭代');
      return false;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      setError('请粘贴需求或任务说明');
      return false;
    }
    setBatchPreviewLoading(true);
    setError(null);
    setBatchPreviewTasks(null);
    try {
      const res = await fetch('/api/workflows/tasks/batch-spec/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: effectiveProjectId,
          sprintId,
          rawText: trimmed,
        }),
      });
      if (!res.ok) {
        throw new Error(await errorMessageFromApiResponse(res));
      }
      const data = (await res.json()) as { tasks?: { title: string; dependsOnIndices?: number[] }[] };
      if (!data.tasks?.length) {
        throw new Error('未生成任何任务');
      }
      setBatchPreviewTasks(
        data.tasks.map((t) => ({
          title: t.title,
          dependsOnIndices: Array.isArray(t.dependsOnIndices) ? t.dependsOnIndices : [],
        })),
      );
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBatchPreviewLoading(false);
    }
  }

  async function runBatchCreatePreview() {
    await runBatchSpecPreviewFromRaw(batchCreateText);
  }

  /** 需求讨论里确认方案后：用同一条 batch-spec 流程生成任务预览，并打开「批量创建」弹窗以便「创建到待办」 */
  async function confirmBrainstormPlanAndOpenBatch() {
    if (brainstormStreaming || busy || batchPreviewLoading) return;
    if (!effectiveProjectId || !sprintId) {
      setError('请先选择项目与迭代');
      return;
    }
    const rawText = formatBrainstormTranscriptForBatch(brainstormMessages);
    if (!rawText.trim()) {
      setError('请先与助手讨论并确认方案（对话内容不能为空）');
      return;
    }
    setBatchCreateText(rawText);
    const ok = await runBatchSpecPreviewFromRaw(rawText);
    if (ok) {
      setBrainstormOpen(false);
      setBatchCreateOpen(true);
    }
  }

  async function sendBrainstormMessage() {
    const text = brainstormInput.trim();
    if (!text || !effectiveProjectId || brainstormStreaming) return;
    const priorHistory = brainstormMessages;
    setBrainstormInput('');
    setBrainstormStreaming(true);
    setError(null);
    setBrainstormMessages((m) => [...m, { role: 'user', content: text }, { role: 'assistant', content: '' }]);
    let assistantAcc = '';
    try {
      const res = await fetch('/api/workflows/board-brainstorm/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: effectiveProjectId,
          sessionId: brainstormSessionId,
          sdkSessionId: brainstormSdkSessionId ?? undefined,
          message: text,
          conversationHistory: priorHistory,
        }),
      });
      if (!res.ok) {
        setBrainstormMessages((m) => m.slice(0, -2));
        throw new Error(await errorMessageFromApiResponse(res));
      }
      const reader = res.body?.getReader();
      if (!reader) {
        setBrainstormMessages((m) => m.slice(0, -2));
        throw new Error('No response body');
      }
      const dec = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += dec.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          let event: { type: string; data: string };
          try {
            event = JSON.parse(line.slice(6)) as { type: string; data: string };
          } catch {
            continue;
          }
          if (event.type === 'text') {
            assistantAcc += event.data;
            setBrainstormMessages((prev) => {
              const next = [...prev];
              const last = next[next.length - 1];
              if (last?.role === 'assistant') {
                next[next.length - 1] = { role: 'assistant', content: assistantAcc };
              }
              return next;
            });
          }
          if (event.type === 'error') {
            throw new Error(event.data || 'Stream error');
          }
          if (event.type === 'status' || event.type === 'result') {
            try {
              const payload = JSON.parse(event.data) as { session_id?: string };
              if (payload.session_id) {
                setBrainstormSdkSessionId(payload.session_id);
              }
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setBrainstormMessages((m) => {
        if (m.length >= 2 && m[m.length - 1]?.role === 'assistant' && m[m.length - 2]?.role === 'user') {
          return m.slice(0, -2);
        }
        return m;
      });
    } finally {
      setBrainstormStreaming(false);
    }
  }

  async function commitBatchCreateTasks() {
    if (!effectiveProjectId || !sprintId || !batchPreviewTasks?.length) {
      setError('请先生成任务列表');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/workflows/tasks/batch-spec/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: effectiveProjectId,
          sprintId,
          tasks: batchPreviewTasks,
        }),
      });
      if (!res.ok) {
        throw new Error(await errorMessageFromApiResponse(res));
      }
      setBatchCreateOpen(false);
      setBatchCreateText('');
      setBatchPreviewTasks(null);
      await load();
      await loadDependencyPickerTasks(effectiveProjectId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
        if (!res.ok) {
          let errMsg: string;
          try {
            const body = (await res.json()) as { error?: string };
            errMsg = body?.error ?? (await res.text());
          } catch {
            errMsg = await res.text();
          }
          throw new Error(`[${task.issueId}] ${errMsg}`);
        }
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
    const gen = ++taskDetailLoadGenRef.current;
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
      if (gen !== taskDetailLoadGenRef.current) return;
      if (!taskRes.ok) throw new Error(await taskRes.text());
      const full = (await taskRes.json()) as TaskSession;
      if (gen !== taskDetailLoadGenRef.current) return;
      if (rolesRes.ok) {
        const data = (await rolesRes.json()) as { members?: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>> };
        setTaskDetailMembers(data.members ?? {});
      } else {
        setTaskDetailMembers({});
      }
      if (gen !== taskDetailLoadGenRef.current) return;
      if (sprintRes.ok) {
        setTaskDetailSprint((await sprintRes.json()) as Sprint);
      }
      if (gen !== taskDetailLoadGenRef.current) return;
      setTaskDetailModal(full);
    } catch (e) {
      if (gen === taskDetailLoadGenRef.current) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (gen === taskDetailLoadGenRef.current) {
        setTaskDetailLoading(false);
      }
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
      setAssignModalKanbanMapping(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const expectedTaskId = task.id;
      try {
        const res = await fetch(`/api/projects/${encodeURIComponent(task.projectId)}/kanban-roles`, {
          cache: 'no-store',
        });
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as {
          members?: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>>;
          mapping?: Partial<Record<KanbanAgentKind, string>>;
        };
        if (cancelled || assignModalTaskIdRef.current !== expectedTaskId) return;
        setLaneMembersByKind(data.members ?? {});
        setAssignModalKanbanMapping(data.mapping ?? {});
      } catch {
        if (cancelled || assignModalTaskIdRef.current !== expectedTaskId) return;
        setLaneMembersByKind({});
        setAssignModalKanbanMapping({});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [assignModalTask]);

  useEffect(() => {
    if (!bulkAssignOpen || !bulkAssignProjectIdForRoles) {
      setBulkLaneMembersByKind(null);
      setBulkAssignKanbanMapping(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const expectedPid = bulkAssignProjectIdForRoles;
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(bulkAssignProjectIdForRoles)}/kanban-roles`,
          { cache: 'no-store' },
        );
        if (!res.ok) throw new Error(await res.text());
        const data = (await res.json()) as {
          members?: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>>;
          mapping?: Partial<Record<KanbanAgentKind, string>>;
        };
        if (cancelled || bulkAssignProjectIdRef.current !== expectedPid) return;
        setBulkLaneMembersByKind(data.members ?? {});
        setBulkAssignKanbanMapping(data.mapping ?? {});
      } catch {
        if (cancelled || bulkAssignProjectIdRef.current !== expectedPid) return;
        setBulkLaneMembersByKind({});
        setBulkAssignKanbanMapping({});
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
    if (bulkAssignKanbanMapping === null || bulkLaneMembersByKind === null) {
      setError('正在加载该项目的角色与 Runner 配置，请稍后重试');
      return;
    }
    if (bulkAssignMode === 'manual' && bulkModalTodoAssignOptions.length > 0 && !bulkAssigneeOptionValue.trim()) {
      setError('已选择「指定人员」时请选择一个负责人');
      return;
    }
    if (bulkModalTodoAssignOptions.length > 0 && bulkAssignMode === 'manual') {
      const parsed = parseTodoAssigneeOptionValue(bulkAssigneeOptionValue.trim());
      if (!parsed) {
        setError('请选择一个负责人');
        return;
      }
    }
    if (!projectHasAllAgentLaneDefaultRunners(bulkAssignKanbanMapping)) {
      setError(
        '无法分配：请先在「角色与 Runner」为所有 agent lane（开发、前置测试、高级开发、评审、测试）配置「单 lane 默认 runner」。',
      );
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
    if (assignModalKanbanMapping === null || laneMembersByKind === null) {
      setError('正在加载该项目的角色与 Runner 配置，请稍后重试');
      return;
    }
    if (modalTodoAssignOptions.length > 0 && modalAssignMode === 'manual' && !modalAssigneeOptionValue.trim()) {
      setError('已选择「指定人员」时请选择一个负责人');
      return;
    }
    let laneForRunner: KanbanAgentKind = inferKanbanAgentForTodoAuto(task);
    if (modalTodoAssignOptions.length > 0 && modalAssignMode === 'manual') {
      const parsed = parseTodoAssigneeOptionValue(modalAssigneeOptionValue.trim());
      if (!parsed) {
        setError('请选择一个负责人');
        return;
      }
      laneForRunner = parsed.kind;
    }
    if (!projectHasAllAgentLaneDefaultRunners(assignModalKanbanMapping)) {
      setError(
        '无法分配：请先在「角色与 Runner」为所有 agent lane（开发、前置测试、高级开发、评审、测试）配置「单 lane 默认 runner」。',
      );
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

  async function blockTaskApi(task: TaskSession) {
    const reason = window.prompt(`阻塞任务「${task.issueId}」——请输入阻塞原因：`);
    if (reason === null) return; // cancelled
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${encodeURIComponent(task.id)}/block`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || '已阻塞' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? await res.text());
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function unblockTaskApi(task: TaskSession) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${encodeURIComponent(task.id)}/unblock`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? await res.text());
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uatApproveApi(task: TaskSession) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${encodeURIComponent(task.id)}/uat-approve`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? await res.text());
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uatRejectApi(task: TaskSession) {
    const reason = window.prompt(`UAT 打回任务「${task.issueId}」——请输入打回原因：`);
    if (reason === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${encodeURIComponent(task.id)}/uat-reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || 'UAT 打回' }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(body?.error ?? await res.text());
      }
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
        throw new Error(await errorMessageFromApiResponse(res));
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
      task.workflowState !== 'pending_uat' &&
      task.workflowState !== 'closing' &&
      task.workflowState !== 'blocked' &&
      task.workflowState !== 'closed' &&
      // Self-host-runner CI wait: no manual advance (CI webhook pushes it)
      !(task.workflowState === 'regression_testing' && task.kanbanAgent === 'self-host-runner')
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
            todo → 队列(pending_start) → in_progress → pre_testing → testing → review →
            regression_testing → pending_release → closed
          </code>
          。从待办分配后先入队；服务端会按顺序扫描队列，依赖满足即可开始开发（可多卡并行），被依赖卡住的项仍留在队列直至上游就绪。
          <strong>点击卡片标题</strong>查看任务详情（分配快照、工作流记录、各角色发言）；待办卡片点「领取」分配任务。<strong>活跃列</strong>可「手动推进」（向当前 lane 入队用户消息）。自动推进失败时由 <code>system_check</code> 循环确认，上限{' '}
          <code>CTI_KANBAN_CONFIRMATION_MAX_LOOPS</code>（默认 10）。提交评审、PR、测试/回归、关单等仍由各 lane agent 调 API 完成。
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
            {kanbanStatus.tasksByState.in_progress} · 前置测试 {kanbanStatus.tasksByState.pre_testing ?? 0} · 评审 {kanbanStatus.tasksByState.review} · 测试{' '}
            {kanbanStatus.tasksByState.testing} · 回归 {kanbanStatus.tasksByState.regression_testing}
            {(kanbanStatus.tasksByState as Record<string, number>).pending_uat ? ` · UAT ${(kanbanStatus.tasksByState as Record<string, number>).pending_uat}` : ''} · 合并主干{' '}
            {kanbanStatus.tasksByState.pending_release}
            {(kanbanStatus.tasksByState as Record<string, number>).blocked ? ` · 阻塞 ${(kanbanStatus.tasksByState as Record<string, number>).blocked}` : ''} · 完成{' '}
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
                      {row.tasksByState.in_progress} · 前置测试 {row.tasksByState.pre_testing ?? 0} · 评审 {row.tasksByState.review} · 测试 {row.tasksByState.testing} · 回归{' '}
                      {row.tasksByState.regression_testing}
                      {(row.tasksByState as Record<string, number>).pending_uat ? ` · UAT ${(row.tasksByState as Record<string, number>).pending_uat}` : ''} · 合并主干 {row.tasksByState.pending_release}
                      {(row.tasksByState as Record<string, number>).blocked ? ` · 阻塞 ${(row.tasksByState as Record<string, number>).blocked}` : ''} · 完成{' '}
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
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '0.75rem',
            marginBottom: '0.5rem',
          }}
        >
          <h2 className="ui-h2" style={{ margin: 0 }}>
            新建任务（进入待办）
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
            <button
              type="button"
              className="ui-btn secondary"
              disabled={busy || !effectiveProjectId}
              title={!effectiveProjectId ? '请先添加至少一个项目' : undefined}
              onClick={() => {
                setBrainstormOpen(true);
                setBrainstormSessionId(
                  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                    ? crypto.randomUUID()
                    : `board-${Date.now()}`,
                );
                setBrainstormSdkSessionId(null);
                setBrainstormMessages([]);
                setBrainstormInput('');
                setError(null);
              }}
            >
              需求讨论
            </button>
            <button
              type="button"
              className="ui-btn secondary"
              disabled={busy || !effectiveProjectId || !sprintId}
              title={!effectiveProjectId ? '请先添加至少一个项目' : !sprintId ? '请先选择迭代' : undefined}
              onClick={() => {
                setBatchCreateOpen(true);
                setBatchCreateText('');
                setBatchPreviewTasks(null);
                setError(null);
              }}
            >
              批量创建
            </button>
          </div>
        </div>
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
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={createIsHotfix}
              onChange={(e) => setCreateIsHotfix(e.target.checked)}
            />
            快速通道（跳过前置测试）
          </label>
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
                      {task.isHotfix ? (
                        <span style={{ display: 'inline-block', fontSize: '0.65rem', fontWeight: 700, background: '#f59e0b', color: '#000', borderRadius: 4, padding: '1px 6px', marginRight: 4 }}>
                          HOTFIX
                        </span>
                      ) : null}
                      {task.workflowState === 'closing' ? (
                        <p className="ui-card-meta" style={{ color: 'var(--ui-accent, #38bdf8)' }}>
                          ⏳ 正在验证合并并检查覆盖率…
                        </p>
                      ) : null}
                      {task.workflowState === 'regression_testing' && task.kanbanAgent === 'self-host-runner' ? (
                        <p className="ui-card-meta" style={{ color: 'var(--ui-accent, #38bdf8)' }}>
                          ⏳ 等待 Self-Hosted Runner CI 结果…
                        </p>
                      ) : null}
                      {task.workflowState === 'blocked' ? (
                        <p className="ui-card-meta" style={{ color: '#f87171' }}>
                          🚫 {task.blockReason ?? '已阻塞'}
                        </p>
                      ) : null}
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
                      {task.workflowState === 'regression_testing' && task.kanbanAgent === 'self-host-runner' ? (
                        <button
                          type="button"
                          className="ui-btn ghost ui-btn-tiny"
                          title="复制 CI Webhook URL（粘贴到 GitHub Actions workflow）"
                          onClick={(e) => {
                            e.stopPropagation();
                            const url = `${window.location.origin}/api/workflows/tasks/${task.id}/ci-result`;
                            void navigator.clipboard.writeText(url).then(() => {
                              alert(`已复制 Webhook URL:\n${url}`);
                            });
                          }}
                        >
                          📋 复制 Webhook URL
                        </button>
                      ) : null}
                      {task.workflowState === 'pending_uat' ? (
                        <>
                          <button
                            type="button"
                            className="ui-btn ghost ui-btn-tiny"
                            disabled={busy}
                            onClick={(e) => { e.stopPropagation(); void uatApproveApi(task); }}
                          >
                            ✅ UAT通过
                          </button>
                          <button
                            type="button"
                            className="ui-btn ghost ui-btn-tiny"
                            disabled={busy}
                            onClick={(e) => { e.stopPropagation(); void uatRejectApi(task); }}
                          >
                            ❌ UAT打回
                          </button>
                        </>
                      ) : null}
                      {task.workflowState === 'blocked' ? (
                        <button
                          type="button"
                          className="ui-btn ghost ui-btn-tiny"
                          disabled={busy}
                          onClick={(e) => { e.stopPropagation(); void unblockTaskApi(task); }}
                        >
                          解除阻塞
                        </button>
                      ) : null}
                      {canManualAdvance(task) ? (
                        <>
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
                          <button
                            type="button"
                            className="ui-btn ghost ui-btn-tiny"
                            disabled={busy}
                            title="阻塞此任务（停止 runner）"
                            onClick={(e) => { e.stopPropagation(); void blockTaskApi(task); }}
                          >
                            阻塞
                          </button>
                        </>
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
            ) : null}
            {assignModalKanbanMapping === null || laneMembersByKind === null ? (
              <p className="ui-muted ui-small" style={{ marginTop: '0.75rem' }}>
                正在加载角色与 Runner 配置…
              </p>
            ) : !assignModalCanAssignFromTodo ? (
              <p className="ui-small" style={{ marginTop: '0.75rem', color: '#f87171' }}>
                无法分配：请先打开{' '}
                <a href="/board/roles" className="ui-link">
                  角色与 Runner
                </a>
                ，为当前将使用的开发 lane 配置「单 lane 默认 runner」或至少一名人员（自动分配时按任务可能使用{' '}
                <code>agent-开发</code> 或 <code>codex-高级开发</code>；指定人员时以所选 lane 为准）。
              </p>
            ) : modalTodoAssignOptions.length === 0 ? (
              <p className="ui-muted ui-small" style={{ marginTop: '0.75rem' }}>
                该项目已为当前将使用的开发 lane 配置「单 lane 默认 runner」或至少一名人员，可分配并启动。
              </p>
            ) : null}
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
              <button
                type="button"
                className="ui-btn primary"
                disabled={busy || !assignModalCanAssignFromTodo}
                onClick={() => void confirmAssignFromTodo()}
              >
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
                ) : null}
                {bulkAssignKanbanMapping === null || bulkLaneMembersByKind === null ? (
                  <p className="ui-muted ui-small" style={{ marginTop: '0.35rem' }}>
                    正在加载角色与 Runner 配置…
                  </p>
                ) : !bulkTodoAssignFromTodoAllowed ? (
                  <p className="ui-small" style={{ marginTop: '0.35rem', color: '#f87171' }}>
                    无法分配：请先在{' '}
                    <a href="/board/roles" className="ui-link">
                      角色与 Runner
                    </a>{' '}
                    为对应项目配置各 lane 的默认 runner 或人员（自动分配时按任务分别使用 agent-开发 / codex-高级开发 lane；指定人员时以所选 lane 为准）。
                  </p>
                ) : bulkModalTodoAssignOptions.length === 0 ? (
                  <p className="ui-muted ui-small" style={{ marginTop: '0.35rem' }}>
                    已为所选任务将使用的开发 lane 配置 runner 或人员，可批量分配。
                  </p>
                ) : null}
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
                  bulkSelectedSpansMultipleProjects ||
                  !bulkTodoAssignFromTodoAllowed
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

      {batchCreateOpen ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 202,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
            background: 'rgba(2, 6, 23, 0.72)',
          }}
          onClick={() => setBatchCreateOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="batch-create-modal-title"
            className="ui-panel"
            style={{ maxWidth: 640, width: '100%', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="batch-create-modal-title" className="ui-h2" style={{ marginTop: 0, flexShrink: 0 }}>
              批量创建任务
            </h2>
            <p className="ui-muted ui-small" style={{ marginBottom: '0.75rem' }}>
              使用当前选择的<strong>项目</strong>与<strong>迭代</strong>（与下方「新建任务」表单一致）。粘贴需求、设计或清单后，由{' '}
              <strong>高级开发（codex-senior）</strong> 对应的 Codex runner 生成带依赖关系的任务列表；预览无误后再写入待办。
            </p>
            <p className="ui-muted ui-small" style={{ marginBottom: '0.5rem' }}>
              项目：<strong>{effectiveProjectId ? projectLabel(effectiveProjectId) : '—'}</strong> · 迭代：
              <strong>
                {sprintId ? (sprints.find((s) => s.id === sprintId)?.name ?? sprintId) : '—'}
              </strong>
            </p>
            <label style={{ display: 'block', flexShrink: 0 }}>
              粘贴内容
              <textarea
                className="ui-input"
                style={{ width: '100%', minHeight: 160, marginTop: 6 }}
                value={batchCreateText}
                onChange={(e) => setBatchCreateText(e.target.value)}
                placeholder="粘贴 PRD、技术方案、bullet list 等…"
                disabled={batchPreviewLoading || busy}
              />
            </label>
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap', flexShrink: 0 }}>
              <button
                type="button"
                className="ui-btn"
                disabled={busy || batchPreviewLoading || !effectiveProjectId || !sprintId}
                onClick={() => void runBatchCreatePreview()}
              >
                {batchPreviewLoading ? '生成中…' : '生成任务列表'}
              </button>
            </div>
            {batchPreviewTasks ? (
              <div style={{ marginTop: '1rem', flex: 1, minHeight: 0, overflow: 'auto' }}>
                <p className="ui-muted ui-small" style={{ marginBottom: '0.5rem' }}>
                  预览（可再次点击「生成任务列表」覆盖）。「创建到待办」会把下表中的依赖写入真实任务（与「本批序号」一致）。
                </p>
                <ol style={{ margin: 0, paddingLeft: '1.25rem' }}>
                  {batchPreviewTasks.map((t, i) => (
                    <li key={i} style={{ marginBottom: '0.5rem' }}>
                      <span>{t.title}</span>
                      {t.dependsOnIndices?.length ? (
                        <span className="ui-muted ui-small" style={{ display: 'block', marginTop: 2 }}>
                          依赖（本批序号）：{' '}
                          {t.dependsOnIndices
                            .map((j) => {
                              const dep = batchPreviewTasks[j];
                              return dep ? `${j + 1}. ${dep.title}` : String(j + 1);
                            })
                            .join('；')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
            <div className="ui-actions-bar" style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button type="button" className="ui-btn ghost" disabled={busy} onClick={() => setBatchCreateOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="ui-btn primary"
                disabled={busy || !batchPreviewTasks?.length}
                onClick={() => void commitBatchCreateTasks()}
              >
                创建到待办
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {brainstormOpen ? (
        <div
          role="presentation"
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 203,
            display: 'flex',
            alignItems: 'stretch',
            justifyContent: 'stretch',
            padding: 0,
            background: 'rgba(2, 6, 23, 0.72)',
          }}
          onClick={() => setBrainstormOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="brainstorm-modal-title"
            className="ui-panel"
            style={{
              width: '100%',
              height: '100%',
              maxWidth: 'none',
              maxHeight: 'none',
              minHeight: '100%',
              boxSizing: 'border-box',
              borderRadius: 0,
              display: 'flex',
              flexDirection: 'column',
              padding: '1rem 1.25rem',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="brainstorm-modal-title" className="ui-h2" style={{ marginTop: 0, flexShrink: 0 }}>
              需求讨论
            </h2>
            <p className="ui-muted ui-small" style={{ marginBottom: '0.5rem' }}>
              使用当前<strong>项目</strong>仓库与<strong>高级开发（codex-senior）</strong> Codex runner 流式回复；底层为<strong>只读沙箱</strong>，无法写入仓库或执行改码命令。对话按 brainstorming：澄清 → 方案对比 → 分块设计 → 引导将结论整理为{' '}
              <code className="ui-mono" style={{ fontSize: 12 }}>
                docs/plans/
              </code>
              下的 Markdown 计划（仅产出讨论与计划文案，不实施代码）。
            </p>
            <p className="ui-muted ui-small" style={{ marginBottom: '0.75rem' }}>
              项目：<strong>{effectiveProjectId ? projectLabel(effectiveProjectId) : '—'}</strong>
              {' · '}
              迭代：
              <strong>{sprintId ? (sprints.find((s) => s.id === sprintId)?.name ?? sprintId) : '—'}</strong>
              （未在表单选项目时使用列表中的第一个项目；批量拆任务需已选迭代）
            </p>
            <div
              className="ui-task-detail-scroll"
              style={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                border: '1px solid rgba(148, 163, 184, 0.2)',
                borderRadius: 8,
                padding: '12px',
                marginBottom: '0.75rem',
                background: 'rgba(15, 23, 42, 0.35)',
              }}
            >
              {brainstormMessages.length === 0 ? (
                <p className="ui-muted ui-small" style={{ margin: 0 }}>
                  先用一句话说明你的目标；助手会复述理解并<strong>一次只问一个</strong>澄清问题，随后再带你收敛方案并整理成可保存的 plan 文档路径建议。
                </p>
              ) : (
                brainstormMessages.map((msg, i) => (
                  <div
                    key={i}
                    style={{
                      marginBottom: '0.75rem',
                      textAlign: msg.role === 'user' ? 'right' : 'left',
                    }}
                  >
                    <span
                      className="ui-muted ui-small"
                      style={{ display: 'block', marginBottom: 4 }}
                    >
                      {msg.role === 'user' ? '你' : '高级开发'}
                    </span>
                    <div
                      style={{
                        display: 'inline-block',
                        maxWidth: '100%',
                        textAlign: 'left',
                        padding: '8px 12px',
                        borderRadius: 8,
                        background:
                          msg.role === 'user'
                            ? 'rgba(59, 130, 246, 0.22)'
                            : 'rgba(148, 163, 184, 0.12)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {msg.content || (msg.role === 'assistant' && brainstormStreaming ? '…' : '')}
                    </div>
                  </div>
                ))
              )}
            </div>
            <label style={{ display: 'block', flexShrink: 0 }}>
              消息
              <textarea
                className="ui-input"
                style={{ width: '100%', minHeight: 88, marginTop: 6 }}
                value={brainstormInput}
                onChange={(e) => setBrainstormInput(e.target.value)}
                placeholder={
                  brainstormMessages.length === 0
                    ? '例如：希望为看板增加深色模式、或优化某条工作流…'
                    : '回复上一问，或补充约束与验收标准…'
                }
                disabled={brainstormStreaming || busy}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void sendBrainstormMessage();
                  }
                }}
              />
            </label>
            <div className="ui-actions-bar" style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <button type="button" className="ui-btn ghost" disabled={brainstormStreaming} onClick={() => setBrainstormOpen(false)}>
                关闭
              </button>
              <button
                type="button"
                className="ui-btn secondary"
                disabled={brainstormStreaming || batchPreviewLoading}
                onClick={() => {
                  setBrainstormSessionId(
                    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
                      ? crypto.randomUUID()
                      : `board-${Date.now()}`,
                  );
                  setBrainstormSdkSessionId(null);
                  setBrainstormMessages([]);
                  setBrainstormInput('');
                  setError(null);
                }}
              >
                新对话
              </button>
              <button
                type="button"
                className="ui-btn secondary"
                disabled={
                  brainstormStreaming ||
                  busy ||
                  batchPreviewLoading ||
                  !effectiveProjectId ||
                  !sprintId ||
                  brainstormMessages.length === 0
                }
                title={
                  !effectiveProjectId
                    ? '请先添加至少一个项目'
                    : !sprintId
                      ? '请先在下方「迭代」中选择当前迭代'
                      : brainstormMessages.length === 0
                        ? '先发送至少一条消息'
                        : undefined
                }
                onClick={() => void confirmBrainstormPlanAndOpenBatch()}
              >
                {batchPreviewLoading ? '生成任务预览中…' : '确认方案并生成待办任务'}
              </button>
              <button
                type="button"
                className="ui-btn primary"
                disabled={brainstormStreaming || busy || !effectiveProjectId || !brainstormInput.trim()}
                onClick={() => void sendBrainstormMessage()}
              >
                {brainstormStreaming ? '流式生成中…' : '发送'}
              </button>
            </div>
            <p className="ui-muted ui-small" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
              快捷键：⌘/Ctrl + Enter 发送。方案成熟后可点「确认方案并生成待办任务」打开批量创建；平时以助手引导的{' '}
              <code className="ui-mono" style={{ fontSize: 12 }}>
                docs/plans/
              </code>
              文档为主。
            </p>
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
