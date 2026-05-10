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
  const [detailModalId, setDetailModalId] = useState<string | null>(null);

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

  const detailModalRow = useMemo(() => {
    if (!detailModalId || !data) return null;
    return data.rows.find((r) => r.id === detailModalId) ?? null;
  }, [detailModalId, data]);

  useEffect(() => {
    if (!detailModalId || !data) return;
    if (!data.rows.some((r) => r.id === detailModalId)) {
      setDetailModalId(null);
    }
  }, [data, detailModalId]);

  useEffect(() => {
    if (!detailModalRow) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setDetailModalId(null);
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [detailModalRow]);

  return (
    <main className="page-shell ui-board ui-board-monitor">
      <header className="ui-admin-header">
        <p className="eyebrow">运维</p>
        <h1>Kanban 监控 — Agent 调用记录</h1>
        <p className="lead ui-muted">
          按项目与 <code>taskId</code>（Issue）筛选。每行在<strong>目标 Agent 即将执行一轮</strong>时写入（含完整 prompt）。语义：
          <strong>source agent</strong> / <strong>target agent</strong> 对<strong>模型侧 agent</strong>统一为
          <strong> 角色名 / runner 类型</strong>（如 <code>开发/claude</code>、<code>评审/codex</code>）；人为跟进为{' '}
          <code>Human</code>；自动确认轮为 <code>system check</code>。
          <strong>target agent prompt</strong> 即本回合发给运行时的全文。流式失败会写入 <code>stream_error</code>。数据表{' '}
          <code>kanban_agent_turns</code>。
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
                <th>详情</th>
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
                  <td>{formatMonitorAgentColumn(row.sourceAgent)}</td>
                  <td>{formatMonitorAgentColumn(row.targetAgent)}</td>
                  <td className="monitor-cell-clip">{clipText(row.sourceAgentResponse, 120)}</td>
                  <td>
                    <button
                      type="button"
                      className="ui-btn ghost"
                      onClick={() => setDetailModalId(row.id)}
                    >
                      详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {detailModalRow ? (
        <MonitorDetailModal row={detailModalRow} onClose={() => setDetailModalId(null)} />
      ) : null}
    </main>
  );
}

/** 表格/弹层：与后端一致；空串用占位；非 agent 文案原样展示 */
function formatMonitorAgentColumn(s: string, emptyLabel = '—'): string {
  const t = s?.trim();
  if (!t) return emptyLabel;
  return t;
}

function clipText(s: string, max: number): string {
  if (!s) return '—';
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function MonitorDetailModal(props: { row: KanbanAgentTurnRecord; onClose: () => void }) {
  const { row, onClose } = props;
  return (
    <div className="monitor-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="ui-panel monitor-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="monitor-detail-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="monitor-modal-header">
          <div>
            <h2 id="monitor-detail-modal-title" className="ui-h2 monitor-modal-title">
              调用详情
            </h2>
            <p className="ui-muted ui-small ui-mt-code-meta">
              <code>{row.id}</code>
            </p>
          </div>
          <button type="button" className="ui-btn ghost" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="monitor-modal-body">
          {row.streamError ? (
            <p className="ui-banner">
              <strong>流式错误：</strong> {row.streamError}
            </p>
          ) : null}
          <p className="ui-muted">
            <strong>projectId</strong> <code>{row.projectId}</code> · <strong>taskId</strong>{' '}
            <code>{row.taskId}</code>
          </p>
          <h3 className="monitor-modal-section-title">source agent</h3>
          <pre className="monitor-pre monitor-pre-short">
            {formatMonitorAgentColumn(row.sourceAgent, '（初次分配，无来源）')}
          </pre>
          <h3 className="monitor-modal-section-title">target agent</h3>
          <pre className="monitor-pre monitor-pre-short">{formatMonitorAgentColumn(row.targetAgent)}</pre>
          <h3 className="monitor-modal-section-title">source agent 回复（转交前）</h3>
          <pre className="monitor-pre monitor-pre-tall">{row.sourceAgentResponse || '（空）'}</pre>
          <h3 className="monitor-modal-section-title">target agent prompt</h3>
          <pre className="monitor-pre monitor-pre-xl">{row.targetAgentPrompt}</pre>
        </div>
      </div>
    </div>
  );
}
