'use client';

import { useCallback, useEffect, useState } from 'react';

// ── Types ──

type MonitorEntry = {
  text: string;
  ts: number;
  bridgeSlug?: string;
  homeBridge?: string;
};

type MonitorData = {
  masterOut: MonitorEntry[];
  slaveOut: MonitorEntry[];
  runnerStatus?: Record<string, RunnerStatusEntry>;
  error?: string;
};

type RunnerStatusEntry = {
  masterBusy: boolean;
  slaveBusy: boolean;
  masterSince?: number;
  slaveSince?: number;
  updatedAt: number;
};

type DaemonDiskStatus = {
  effectiveRunning: boolean;
  pid?: number;
  slave?: {
    running: boolean;
    effectiveRunning: boolean;
    pid?: number;
  };
};

// ── Page component ──

export default function MonitorPage() {
  const [bridges, setBridges] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [monitorData, setMonitorData] = useState<MonitorData | null>(null);
  const [daemonStatus, setDaemonStatus] = useState<Record<string, DaemonDiskStatus>>({});
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchBridges = useCallback(async () => {
    try {
      const res = await fetch('/api/local-config', { cache: 'no-store' });
      const json = await res.json();
      if (Array.isArray(json.bridges)) setBridges(json.bridges);
      else if (json.botName) setBridges([json.botName]);
      if (json.daemonStatusByBridge) setDaemonStatus(json.daemonStatusByBridge);
    } catch {
      /* ignore */
    }
  }, []);

  const fetchMonitor = useCallback(async () => {
    try {
      const res = await fetch('/api/monitor/responses', { cache: 'no-store' });
      const json = await res.json();
      setMonitorData(json);
    } catch (err) {
      setMonitorData({ masterOut: [], slaveOut: [], error: String(err) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchBridges();
    void fetchMonitor();
  }, [fetchBridges, fetchMonitor]);

  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      void fetchMonitor();
      void fetchBridges();
    }, 5000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchMonitor, fetchBridges]);

  const toggle = (slug: string) => setExpanded((prev) => ({ ...prev, [slug]: !prev[slug] }));

  const isExpanded = (slug: string) => expanded[slug] !== false;

  const masterCount = monitorData?.masterOut?.length ?? 0;
  const slaveCount = monitorData?.slaveOut?.length ?? 0;

  return (
    <main className="page-shell ui-monitor">
      <header className="ui-monitor-header">
        <h1>Auto Mode Monitor</h1>
        <a className="ui-monitor-back" href="/admin">
          ← 管理后台
        </a>
        <div className="ui-monitor-toolbar">
          <label className="ui-small ui-muted ui-monitor-checkbox-label">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            每 5 秒刷新
          </label>
          <button type="button" className="ui-btn secondary ui-small" onClick={() => void fetchMonitor()}>
            刷新
          </button>
        </div>
      </header>

      {loading ? <p className="ui-muted">加载中…</p> : null}
      {monitorData?.error ? (
        <div className="ui-banner-error" role="alert">
          <strong>错误：</strong> {monitorData.error}
        </div>
      ) : null}

      <div className="ui-stat-grid">
        <StatCard label="Master 消息" value={masterCount} />
        <StatCard label="Slave 消息" value={slaveCount} />
      </div>

      <div className="ui-bridge-accordion" role="list">
        {(bridges.length > 0 ? bridges : ['default']).map((b) => {
          const dm = daemonStatus[b];
          const rs = monitorData?.runnerStatus?.[b];
          const bridgeMaster = (monitorData?.masterOut ?? []).filter(
            (e) => e.homeBridge === b || (!e.homeBridge && bridges.length <= 1),
          );
          const bridgeSlave = (monitorData?.slaveOut ?? []).filter(
            (e) => e.homeBridge === b || (!e.homeBridge && bridges.length <= 1),
          );
          return (
            <div key={b} className="ui-bridge-accordion-item" role="listitem">
              <button
                type="button"
                className="ui-bridge-accordion-head ui-bridge-accordion-head-interactive"
                onClick={() => toggle(b)}
              >
                <span className="ui-bridge-accordion-chevron ui-bridge-accordion-chevron-gap" aria-hidden>
                  {isExpanded(b) ? '▼' : '▶'}
                </span>
                <code className="ui-bridge-code-strong">{b}</code>
                <span className="ui-muted ui-small ui-bridge-head-meta">
                  <span className="ui-inline-cluster-tight">
                    Master
                    <span className={dm?.effectiveRunning ? 'ui-dot ui-dot-on' : 'ui-dot ui-dot-off'} title={dm?.effectiveRunning ? '运行中' : '未运行'} />
                  </span>
                  <span className="ui-inline-cluster-tight">
                    Slave
                    <span
                      className={dm?.slave?.effectiveRunning ? 'ui-dot ui-dot-on' : 'ui-dot ui-dot-off'}
                      title={dm?.slave?.effectiveRunning ? '运行中' : '未运行'}
                    />
                  </span>
                  <span className="ui-muted-dim ui-bridge-count-note">
                    ({bridgeMaster.length}M / {bridgeSlave.length}S)
                  </span>
                </span>
              </button>

              {isExpanded(b) ? (
                <div className="ui-bridge-accordion-body-monitor">
                  <RunnerStatusBar status={rs} />

                  <div className="ui-monitor-split">
                    <div>
                      <h3 className="ui-monitor-section-title ui-monitor-section-title-master">
                        Master（{bridgeMaster.length}）
                      </h3>
                      <MessageList entries={bridgeMaster} emptyText="暂无 Master 回复" roleTag="master" />
                    </div>
                    <div>
                      <h3 className="ui-monitor-section-title ui-monitor-section-title-slave">
                        Slave（{bridgeSlave.length}）
                      </h3>
                      <MessageList entries={bridgeSlave} emptyText="暂无 Slave 回复" roleTag="slave" />
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </main>
  );
}

// ── Sub-components ──

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="ui-stat-card">
      <div className="ui-muted ui-small ui-stat-card-label">{label}</div>
      <div className="ui-stat-card-value">{value}</div>
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function formatElapsed(since: number | undefined): string {
  if (!since) return '';
  const sec = Math.floor((Date.now() - since) / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remSec = sec % 60;
  return `${min}m${remSec}s`;
}

function RunnerStatusBar({ status }: { status?: RunnerStatusEntry }) {
  const hasStatus = !!status?.updatedAt;

  return (
    <div className="ui-runner-grid">
      <RunnerChip label="Master" busy={status?.masterBusy ?? false} since={status?.masterSince} hasStatus={hasStatus} accent="master" />
      <RunnerChip label="Slave" busy={status?.slaveBusy ?? false} since={status?.slaveSince} hasStatus={hasStatus} accent="slave" />
    </div>
  );
}

function RunnerChip({
  label,
  busy,
  since,
  hasStatus,
  accent,
}: {
  label: string;
  busy: boolean;
  since?: number;
  hasStatus: boolean;
  accent: 'master' | 'slave';
}) {
  const unknown = !hasStatus;
  const statusText = unknown ? '未知' : busy ? '工作中' : '空闲';
  const elapsed = busy ? formatElapsed(since) : '';
  const labelClass = accent === 'master' ? 'ui-runner-chip-label ui-msg-role-master' : 'ui-runner-chip-label ui-msg-role-slave';

  return (
    <div className={`ui-runner-chip${busy ? ' ui-runner-chip-busy' : ''}`}>
      <div className="ui-flex-fill-min">
        <div className={labelClass}>{label} Runner</div>
        <div className="ui-runner-chip-meta">
          <span className="ui-runner-status-word">{statusText}</span>
          {elapsed ? ` · ${elapsed}` : null}
        </div>
      </div>
      {busy ? <span className="ui-runner-pulse" aria-hidden /> : null}
    </div>
  );
}

function MessageList({
  entries,
  emptyText,
  roleTag,
}: {
  entries: MonitorEntry[];
  emptyText: string;
  roleTag: 'master' | 'slave';
}) {
  const roleClass = roleTag === 'master' ? 'ui-msg-role-master' : 'ui-msg-role-slave';

  if (entries.length === 0) {
    return (
      <p className="ui-muted ui-small">
        {emptyText}
      </p>
    );
  }

  const reversed = [...entries].reverse();

  return (
    <div className="ui-msg-stack">
      {reversed.map((entry, i) => (
        <div key={`${entry.ts}-${i}`} className="ui-msg-card">
          <div className="ui-msg-card-head">
            <span className={`ui-msg-role ${roleClass}`}>
              [{roleTag}] #{entries.length - i}
            </span>
            <span className="ui-muted ui-text-12">{formatTime(entry.ts)}</span>
          </div>
          <pre className="ui-msg-body-pre">{entry.text}</pre>
        </div>
      ))}
    </div>
  );
}
