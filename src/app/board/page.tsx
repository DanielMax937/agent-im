'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TaskSession, TaskWorkflowState } from '../../platform/types';

const COLUMNS: { key: TaskWorkflowState; label: string }[] = [
  { key: 'todo', label: 'To do' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'review', label: 'Review' },
  { key: 'testing', label: 'Testing' },
  { key: 'closed', label: 'Closed' },
];

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
        <p className="eyebrow">Tasks</p>
        <h1>Jira-style board</h1>
        <p className="lead ui-muted">
          Columns follow `workflowState` in `task_sessions.json`. This is a local mirror — not a Jira
          embed.
        </p>
        <nav className="ui-nav">
          <a href="/">Home</a>
          <a href="/admin">Admin</a>
          <button type="button" className="ui-btn ghost" onClick={() => void load()}>
            Refresh
          </button>
        </nav>
      </header>

      {error ? <p className="ui-banner">{error}</p> : null}

      {loading ? (
        <p className="ui-muted">Loading tasks…</p>
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
                      <span className="ui-pill">{task.role}</span>
                    </p>
                    {task.pullRequestUrl ? (
                      <a className="ui-link" href={task.pullRequestUrl} target="_blank" rel="noreferrer">
                        PR
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
