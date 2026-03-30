'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { KanbanAgentKind, Project, Sprint, TaskSession, TaskWorkflowState } from '../../platform/types';

const COLUMNS: { key: TaskWorkflowState; label: string }[] = [
  { key: 'todo', label: '待办' },
  { key: 'in_progress', label: '开发中' },
  { key: 'review', label: '评审中' },
  { key: 'testing', label: '测试中' },
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
  const [projectId, setProjectId] = useState('');
  const [sprintId, setSprintId] = useState('');
  const [createIssueId, setCreateIssueId] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  const [assignAgent, setAssignAgent] = useState<KanbanAgentKind>('agent-dev');
  const [handoff, setHandoff] = useState('');
  const [prByTask, setPrByTask] = useState<Record<string, { commit: string; title: string; body: string }>>({});
  const [rejectByTask, setRejectByTask] = useState<Record<string, string>>({});
  const [kanbanStatus, setKanbanStatus] = useState<KanbanStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function prDraft(taskId: string) {
    return prByTask[taskId] ?? { commit: '', title: '', body: '' };
  }

  function setPrField(taskId: string, patch: Partial<{ commit: string; title: string; body: string }>) {
    setPrByTask((prev) => ({
      ...prev,
      [taskId]: { ...prDraft(taskId), ...patch },
    }));
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const taskUrl = projectId
        ? `/api/tasks?projectId=${encodeURIComponent(projectId)}`
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
  }, [projectId]);

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
    if (projectId) void loadSprints(projectId);
  }, [projectId, loadSprints]);

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
    if (!projectId || !sprintId || !createIssueId.trim() || !createTitle.trim()) {
      setError('请选择项目、迭代，并填写 issueId 与标题');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/workflows/tasks/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          sprintId,
          issueId: createIssueId.trim(),
          title: createTitle.trim(),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setCreateIssueId('');
      setCreateTitle('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function assignFromTodo(task: TaskSession) {
    if (!handoff.trim()) {
      setError('分配前请填写交接说明（会写入 comment 并发 Telegram）');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/workflows/tasks/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: task.projectId,
          sprintId: task.sprintId,
          issueId: task.issueId,
          taskSessionId: task.id,
          kanbanAgent: assignAgent,
          handoffComment: handoff.trim(),
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      setHandoff('');
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

  async function submitReviewApi(task: TaskSession) {
    const d = prDraft(task.id);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${task.id}/submit-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commitMessage: d.commit.trim() || `feat(${task.issueId}): submit for review`,
          prTitle: d.title.trim() || `[${task.issueId}] ${task.title}`,
          prBody: d.body.trim() || 'Submitted from Kanban board.',
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startTestingApi(task: TaskSession) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${task.id}/start-testing`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function rejectReviewApi(task: TaskSession) {
    const c = (rejectByTask[task.id] ?? '').trim();
    if (!c) {
      setError('打回时请填写说明（写入会话并发 Telegram）');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${task.id}/reject-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: c }),
      });
      if (!res.ok) throw new Error(await res.text());
      setRejectByTask((prev) => ({ ...prev, [task.id]: '' }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function startRegressionApi(task: TaskSession) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${task.id}/start-regression`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshRegressionApi(task: TaskSession) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${task.id}/regression/refresh`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function closeTaskApi(task: TaskSession) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workflows/tasks/${task.id}/close`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page-shell ui-board">
      <header className="ui-admin-header">
        <p className="eyebrow">任务</p>
        <h1>Jira Kanban</h1>
        <p className="lead ui-muted">
          <strong>Goal（与 Slave 报告应对齐）</strong>：<strong>Jira Kanban 改造（Claude-to-IM-skill）</strong>
          — 本地看板列 <code>todo → in_progress → review → testing → regression_testing → closed</code>
          。分配/打回/评审/测试/回归 会启动对应 runner；会话记录可 fan-out 到 Telegram（<code>CTI_KANBAN_TELEGRAM_*</code>）；Auto 模式
          下 Slave 报告标题中的 goal 取<strong>最近一次</strong>
          <code>User goal:</code>，也可用环境变量 <code>CTI_SLAVE_REPORT_GOAL</code> 固定。
        </p>
        <p className="lead ui-muted" style={{ marginTop: '0.75rem' }}>
          <strong>产品说明（g：Git / 测试范围）</strong>：开发阶段可启用 worktree（<code>CTI_KANBAN_USE_WORKTREE=1</code>），在独立检出上开发。
          <strong>功能测试</strong>阶段只验证本 task 的验收与功能点；合入 master、解决合并冲突、走 PR 合并仍由后续人工或流程完成，不在此阶段自动合入。
          <strong>回归测试</strong>阶段针对 <code>{'origin/<base>'}</code> 上最新 master（或主分支）跑全量/应用级用例；若在回归过程中主分支出现<strong>新的合并提交</strong>，应<strong>废弃</strong>基于旧提交做的回归分支或本地 checkout，<strong>重新拉取</strong>最新代码后再跑测试，而不是在过时检出上继续补测。工作流提供{' '}
          <code>refreshRegressionIfMasterAdvanced</code> 用于检测主分支前进并刷新 handoff。
        </p>
        <nav className="ui-nav">
          <a href="/">首页</a>
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
            待办 {kanbanStatus.tasksByState.todo} · 开发中 {kanbanStatus.tasksByState.in_progress} · 评审{' '}
            {kanbanStatus.tasksByState.review} · 测试 {kanbanStatus.tasksByState.testing} · 回归{' '}
            {kanbanStatus.tasksByState.regression_testing} · 完成 {kanbanStatus.tasksByState.closed}
          </p>
          <p className="ui-muted">运行中实例数：{kanbanStatus.instances.length}</p>
          <ul className="ui-list">
            {kanbanStatus.tasksByProject && kanbanStatus.tasksByProject.length > 0
              ? kanbanStatus.tasksByProject.map((row) => (
                  <li key={row.projectId}>
                    <strong>{row.name}</strong>
                    {row.owner ? <span className="ui-muted"> — 负责人 {row.owner}</span> : null}
                    <span className="ui-muted" style={{ display: 'block', marginTop: '0.25rem' }}>
                      待办 {row.tasksByState.todo} · 开发中 {row.tasksByState.in_progress} · 评审 {row.tasksByState.review}{' '}
                      · 测试 {row.tasksByState.testing} · 回归 {row.tasksByState.regression_testing} · 完成{' '}
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
        <h2 className="ui-h2">新建任务（进入待办）</h2>
        <div className="ui-form-row" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'flex-end' }}>
          <label>
            项目
            <select
              className="ui-input"
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
                setSprintId('');
              }}
            >
              <option value="">全部项目（看板不筛选）</option>
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
            Issue ID
            <input
              className="ui-input"
              value={createIssueId}
              onChange={(e) => setCreateIssueId(e.target.value)}
              placeholder="PROJ-123"
            />
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
          <button type="button" className="ui-btn" disabled={busy} onClick={() => void createTask()}>
            创建
          </button>
        </div>
      </section>

      <section className="ui-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 className="ui-h2">从待办领取时的 lane</h2>
        <p className="ui-muted">
          从待办领取仅 <code>agent-开发</code> 与 <code>codex-高级开发</code>；<strong>评审累计打回 ≥2 次</strong>时，即使选 agent-开发，服务端也会解析为{' '}
          <strong>codex-高级开发</strong>（<code>resolveKanbanAgent</code>）。其他 lane：<strong>claude-review</strong> 在「提交评审」后、
          <strong>copilot-测试</strong> 在「进入测试」后由工作流挂载。
        </p>
        <label>
          Lane
          <select className="ui-input" value={assignAgent} onChange={(e) => setAssignAgent(e.target.value as KanbanAgentKind)}>
            {TODO_ASSIGN_AGENTS.map((k) => (
              <option key={k} value={k}>
                {KANBAN_AGENT_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'block', marginTop: '0.5rem' }}>
          交接说明（必填）
          <textarea
            className="ui-input"
            style={{ width: '100%', minHeight: 72 }}
            value={handoff}
            onChange={(e) => setHandoff(e.target.value)}
            placeholder="下一位 agent 开始时先读此说明"
          />
        </label>
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
                  <article key={task.id} className="ui-card">
                    <p className="ui-card-title">{task.title}</p>
                    <p className="ui-card-meta ui-muted" style={{ fontSize: '0.85rem' }}>
                      项目：{projects.find((p) => p.id === task.projectId)?.name ?? task.projectId}
                    </p>
                    <p className="ui-card-meta">
                      <span className="ui-mono">{task.issueId}</span>
                      <span>{task.runtime}</span>
                    </p>
                    <p className="ui-card-meta">
                      <span className="ui-pill">{ROLE_LABELS[task.role] ?? task.role}</span>
                      {task.kanbanAgent ? (
                        <span className="ui-pill">{KANBAN_AGENT_LABELS[task.kanbanAgent]}</span>
                      ) : null}
                      {task.reviewRejectionCount ? (
                        <span className="ui-muted">打回 {task.reviewRejectionCount} 次</span>
                      ) : null}
                    </p>
                    {task.handoffComment ? (
                      <p className="ui-card-meta ui-muted" style={{ fontSize: '0.85rem' }}>
                        交接：{task.handoffComment}
                      </p>
                    ) : null}
                    {task.pullRequestUrl ? (
                      <a className="ui-link" href={task.pullRequestUrl} target="_blank" rel="noreferrer">
                        合并请求
                      </a>
                    ) : null}
                    {task.workflowState === 'todo' ? (
                      <p style={{ marginTop: '0.5rem' }}>
                        {task.reviewRejectionCount != null && task.reviewRejectionCount >= 2 ? (
                          <span className="ui-muted" style={{ display: 'block', marginBottom: '0.35rem' }}>
                            打回 ≥2：领取 agent-开发 将自动升级为 codex-高级开发
                          </span>
                        ) : null}
                        <button
                          type="button"
                          className="ui-btn"
                          disabled={busy}
                          onClick={() => void assignFromTodo(task)}
                        >
                          分配并启动 runner
                        </button>
                      </p>
                    ) : null}
                    {task.workflowState === 'in_progress' ? (
                      <div style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>
                        <p className="ui-muted">提交评审 → 创建 PR 并启动 claude-review</p>
                        <input
                          className="ui-input"
                          style={{ width: '100%', marginBottom: 4 }}
                          placeholder="commit message"
                          value={prDraft(task.id).commit}
                          onChange={(e) => setPrField(task.id, { commit: e.target.value })}
                        />
                        <input
                          className="ui-input"
                          style={{ width: '100%', marginBottom: 4 }}
                          placeholder="PR title"
                          value={prDraft(task.id).title}
                          onChange={(e) => setPrField(task.id, { title: e.target.value })}
                        />
                        <textarea
                          className="ui-input"
                          style={{ width: '100%', minHeight: 48, marginBottom: 4 }}
                          placeholder="PR body"
                          value={prDraft(task.id).body}
                          onChange={(e) => setPrField(task.id, { body: e.target.value })}
                        />
                        <button type="button" className="ui-btn" disabled={busy} onClick={() => void submitReviewApi(task)}>
                          提交评审（claude-review）
                        </button>
                      </div>
                    ) : null}
                    {task.workflowState === 'review' ? (
                      <div style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>
                        <button type="button" className="ui-btn" disabled={busy} onClick={() => void startTestingApi(task)}>
                          进入测试（copilot-测试）
                        </button>
                        <textarea
                          className="ui-input"
                          style={{ width: '100%', minHeight: 56, marginTop: 6 }}
                          placeholder="打回说明 → 回到开发（满 2 次打回会走 codex）"
                          value={rejectByTask[task.id] ?? ''}
                          onChange={(e) => setRejectByTask((p) => ({ ...p, [task.id]: e.target.value }))}
                        />
                        <button type="button" className="ui-btn ghost" disabled={busy} onClick={() => void rejectReviewApi(task)}>
                          打回开发
                        </button>
                      </div>
                    ) : null}
                    {task.workflowState === 'testing' ? (
                      <div style={{ marginTop: '0.5rem' }}>
                        <button type="button" className="ui-btn" disabled={busy} onClick={() => void startRegressionApi(task)}>
                          进入回归测试（master / 全量用例）
                        </button>
                      </div>
                    ) : null}
                    {task.workflowState === 'regression_testing' ? (
                      <div style={{ marginTop: '0.5rem', fontSize: '0.9rem' }}>
                        {task.regressionMasterSha ? (
                          <p className="ui-muted">master 基线 {task.regressionMasterSha.slice(0, 7)}…</p>
                        ) : null}
                        <button type="button" className="ui-btn" disabled={busy} onClick={() => void refreshRegressionApi(task)}>
                          检查 master 是否前进（废弃旧回归并重启 tester）
                        </button>
                      </div>
                    ) : null}
                    {task.workflowState === 'testing' || task.workflowState === 'regression_testing' ? (
                      <div style={{ marginTop: '0.35rem' }}>
                        <button type="button" className="ui-btn ghost" disabled={busy} onClick={() => void closeTaskApi(task)}>
                          标记完成
                        </button>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </main>
  );
}
