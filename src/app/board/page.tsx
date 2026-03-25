'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AgentRole, TaskSession, TaskWorkflowState } from '../../platform/types';

const COLUMNS: { key: TaskWorkflowState; label: string }[] = [
  { key: 'todo', label: '待办' },
  { key: 'in_progress', label: '进行中' },
  { key: 'review', label: '评审' },
  { key: 'testing', label: '测试中' },
  { key: 'closed', label: '已关闭' },
];

const ROLE_LABELS: Record<AgentRole, string> = {
  developer: '开发',
  reviewer: '评审',
  tester: '测试',
};

export default function BoardPage() {
  const [tasks, setTasks] = useState<TaskSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as TaskSession[];
      setTasks(Array.isArray(body) ? body : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byColumn = useMemo(() => {
    const map = new Map<TaskWorkflowState, TaskSession[]>();
    for (const col of COLUMNS) map.set(col.key, []);
    for (const t of tasks) {
      const list = map.get(t.workflowState);
      if (list) list.push(t);
    }
    return map;
  }, [tasks]);

  return (
    <main className="page-shell ui-board">
      <header className="ui-admin-header">
        <p className="eyebrow">任务</p>
        <h1>类 Jira 看板</h1>
        <p className="lead ui-muted">
          列对应 <code>task_sessions.json</code> 中的 <code>workflowState</code>。此为本地数据镜像，并非嵌入 Jira 页面。
        </p>
        <nav className="ui-nav">
          <a href="/">首页</a>
          <a href="/admin">管理后台</a>
          <button type="button" className="ui-btn ghost" onClick={() => void load()}>
            刷新
          </button>
        </nav>
      </header>

      {error ? <p className="ui-banner">{error}</p> : null}

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
                    <p className="ui-card-meta">
                      <span className="ui-mono">{task.issueId}</span>
                      <span>{task.runtime}</span>
                    </p>
                    <p className="ui-card-meta">
                      <span className="ui-pill">{ROLE_LABELS[task.role]}</span>
                    </p>
                    {task.pullRequestUrl ? (
                      <a className="ui-link" href={task.pullRequestUrl} target="_blank" rel="noreferrer">
                        合并请求
                      </a>
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
