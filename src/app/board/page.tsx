'use client';

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import type {
  KanbanAgentKind,
  KanbanRoleMember,
  Project,
  Sprint,
  TaskSession,
  TaskWorkflowState,
} from '../../platform/types';

/** Order matches pipeline: 开发 → 功能测试 → PR 评审 → 合并后回归 → 完成 */
const COLUMNS: { key: TaskWorkflowState; label: string }[] = [
  { key: 'todo', label: '待办' },
  { key: 'pending_start', label: '队列' },
  { key: 'in_progress', label: '开发中' },
  { key: 'testing', label: '测试中' },
  { key: 'review', label: '评审中' },
  { key: 'regression_testing', label: '回归测试中' },
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
  /** Comma or space separated issue ids of tasks in the same project that must close first */
  const [createDependsOn, setCreateDependsOn] = useState('');
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

  async function createTask() {
    if (!createProjectId || !sprintId || !createTitle.trim()) {
      setError('请选择项目、迭代，并填写标题（Issue ID 将按项目自动生成）');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const depRaw = createDependsOn.trim();
      const dependsOnIssueIds = depRaw
        ? [...new Set(depRaw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))]
        : undefined;
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
      setCreateDependsOn('');
      await load();
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
      const deps = task.dependsOnIssueIds?.length
        ? ` · 依赖: ${task.dependsOnIssueIds.join(', ')}`
        : '';
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
      task.workflowState !== 'closed'
    );
  }

  const manualModalTaskLive = manualModalTask
    ? tasks.find((t) => t.id === manualModalTask.id) ?? manualModalTask
    : null;
  const manualModalGenerating = !!manualModalTaskLive?.agentGenerating;

  return (
    <main className="page-shell ui-board ui-board-fluid">
      <header className="ui-admin-header">
        <p className="eyebrow">任务</p>
        <h1>Local Kanban</h1>
        <p className="lead ui-muted">
          列：<code>todo → 队列(pending_start) → in_progress → review → testing → regression_testing → closed</code>
          。从待办分配后先入队，依赖项未全部完成时阻塞；队首就绪后才开始开发。
          待办卡片点击标题领取；<strong>活跃列卡片可「手动推进」</strong>（向当前 lane 入队用户消息）。自动推进失败时由 <code>system_check</code> 循环确认，上限{' '}
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
            {kanbanStatus.tasksByState.testing} · 回归 {kanbanStatus.tasksByState.regression_testing} · 完成{' '}
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
                      {row.tasksByState.regression_testing} · 完成 {row.tasksByState.closed}
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
          <label>
            依赖 Issue（可选）
            <input
              className="ui-input"
              value={createDependsOn}
              onChange={(e) => setCreateDependsOn(e.target.value)}
              placeholder="同项目已存在任务的 Issue ID，逗号或空格分隔"
              style={{ minWidth: 280 }}
            />
          </label>
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
                {col.label}
                <span className="ui-count">{byColumn.get(col.key)?.length ?? 0}</span>
              </h2>
              <div className="ui-cards">
                {(byColumn.get(col.key) ?? []).map((task) => (
                  <article key={task.id} className="ui-card ui-card-kanban">
                    <div
                      className="ui-card-kanban-main"
                      style={task.workflowState === 'todo' ? { cursor: 'pointer' } : undefined}
                      role={task.workflowState === 'todo' ? 'button' : undefined}
                      tabIndex={task.workflowState === 'todo' ? 0 : undefined}
                      onKeyDown={
                        task.workflowState === 'todo'
                          ? (e: KeyboardEvent) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                openAssignModal(task);
                              }
                            }
                          : undefined
                      }
                      onClick={
                        task.workflowState === 'todo'
                          ? () => {
                              openAssignModal(task);
                            }
                          : undefined
                      }
                    >
                      <p className="ui-card-title">{task.title}</p>
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
