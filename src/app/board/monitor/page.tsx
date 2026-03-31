'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { KanbanAgentTurnRecord, Project } from '../../../platform/types';

type MonitorResponse = { rows: KanbanAgentTurnRecord[]; total: number };

export default function KanbanMonitorPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [filterProjectId, setFilterProjectId] = useState('');
  const [filterTaskId, setFilterTaskId] = useState('');
  const [data, setData] = useState<MonitorResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<Project[]>)
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (filterProjectId.trim()) p.set('projectId', filterProjectId.trim());
    if (filterTaskId.trim()) p.set('taskId', filterTaskId.trim());
    p.set('limit', '80');
    return p.toString();
  }, [filterProjectId, filterTaskId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/kanban/monitor?${queryString}`, { cache: 'no-store' });
      if (!res.ok) {
        setError(await res.text());
        setData(null);
        return;
      }
      setData((await res.json()) as MonitorResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="page-shell ui-board ui-board-monitor">
      <header className="ui-admin-header">
        <p className="eyebrow">运维</p>
        <h1>Kanban 监控 — Agent 调用记录</h1>
        <p className="lead ui-muted">
          按项目与 <code>taskId</code>（Issue）筛选。每行在<strong>目标 Agent 即将执行</strong>时写入（含完整 prompt）；流式结束后若失败会更新
          <code>stream_error</code>。初次分配时 source / 上一轮回复为空，target 与 prompt 仍有值。数据表 <code>kanban_agent_turns</code>。
        </p>
        <nav className="ui-nav">
          <a href="/">首页</a>
          <a href="/board">看板</a>
          <a href="/board/roles">角色与 Runner</a>
          <a href="/projects">项目管理</a>
        </nav>
      </header>

      <section className="monitor-filters">
        <label>
          项目
          <select
            value={filterProjectId}
            onChange={(e) => setFilterProjectId(e.target.value)}
            aria-label="按项目筛选"
          >
            <option value="">全部</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name || p.id}
              </option>
            ))}
          </select>
        </label>
        <label>
          Issue / taskId
          <input
            type="text"
            value={filterTaskId}
            onChange={(e) => setFilterTaskId(e.target.value)}
            placeholder="例如 DEMO-1"
            aria-label="按 Issue ID 筛选"
          />
        </label>
        <button type="button" className="ui-btn ghost" onClick={() => void load()} disabled={loading}>
          刷新
        </button>
      </section>

      {error ? <p className="ui-banner">{error}</p> : null}

      {loading && !data ? <p className="ui-muted">加载中…</p> : null}

      {data ? (
        <p className="ui-muted">
          共 {data.total} 条，本页 {data.rows.length} 条。
        </p>
      ) : null}

      {data?.rows.length === 0 && !loading ? <p>暂无记录。</p> : null}

      {data && data.rows.length > 0 ? (
        <div className="monitor-table-wrap">
          <table className="monitor-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>projectId</th>
                <th>taskId</th>
                <th>source agent</th>
                <th>target agent</th>
                <th>source 回复（摘要）</th>
                <th>展开</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <time dateTime={row.createdAt}>{row.createdAt.replace('T', ' ').slice(0, 19)}</time>
                  </td>
                  <td>
                    <code>{row.projectId}</code>
                  </td>
                  <td>
                    <code>{row.taskId}</code>
                  </td>
                  <td>{row.sourceAgent || '—'}</td>
                  <td>{row.targetAgent}</td>
                  <td className="monitor-cell-clip">{clipText(row.sourceAgentResponse, 120)}</td>
                  <td>
                    <button
                      type="button"
                      className="ui-btn ghost"
                      onClick={() => setExpandedId((id) => (id === row.id ? null : row.id))}
                    >
                      {expandedId === row.id ? '收起' : '详情'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {expandedId ? (
            <MonitorDetail
              row={data.rows.find((r) => r.id === expandedId) ?? null}
              onClose={() => setExpandedId(null)}
            />
          ) : null}
        </div>
      ) : null}
    </main>
  );
}

function clipText(s: string, max: number): string {
  if (!s) return '—';
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function MonitorDetail(props: { row: KanbanAgentTurnRecord | null; onClose: () => void }) {
  const { row, onClose } = props;
  if (!row) return null;
  return (
    <div className="monitor-detail" role="dialog" aria-label="调用详情">
      <div className="monitor-detail-toolbar">
        <span>
          <code>{row.id}</code>
        </span>
        <button type="button" onClick={onClose}>
          关闭
        </button>
      </div>
      {row.streamError ? (
        <p className="ui-banner">
          <strong>流式错误：</strong> {row.streamError}
        </p>
      ) : null}
      <p className="ui-muted">
        <strong>projectId</strong> <code>{row.projectId}</code> · <strong>taskId</strong>{' '}
        <code>{row.taskId}</code>
      </p>
      <h3>source agent</h3>
      <pre className="monitor-pre monitor-pre-short">{row.sourceAgent || '（初次分配，无来源）'}</pre>
      <h3>target agent</h3>
      <pre className="monitor-pre monitor-pre-short">{row.targetAgent}</pre>
      <h3>source agent 回复（转交前）</h3>
      <pre className="monitor-pre">{row.sourceAgentResponse || '（空）'}</pre>
      <h3>target agent prompt</h3>
      <pre className="monitor-pre">{row.targetAgentPrompt}</pre>
    </div>
  );
}
