'use client';

import { useCallback, useEffect, useState } from 'react';

// ── Types ──

type MonitorEntry = {
  text: string;
  ts: number;
  bridgeSlug?: string;
};

type MonitorData = {
  masterOut: MonitorEntry[];
  slaveOut: MonitorEntry[];
  error?: string;
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
    } catch { /* ignore */ }
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

  const toggle = (slug: string) =>
    setExpanded((prev) => ({ ...prev, [slug]: !prev[slug] }));

  const isExpanded = (slug: string) => expanded[slug] !== false;

  const masterCount = monitorData?.masterOut?.length ?? 0;
  const slaveCount = monitorData?.slaveOut?.length ?? 0;

  return (
    <div className="page-shell" style={{ maxWidth: 1200, margin: '0 auto', padding: '1.5rem 1rem' }}>
      <header style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Auto Mode Monitor</h1>
        <a href="/admin" style={{ fontSize: '0.85rem', color: '#38bdf8' }}>← Admin</a>
        <label style={{ marginLeft: 'auto', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
          Auto-refresh (5s)
        </label>
        <button
          type="button"
          className="ui-btn secondary"
          style={{ fontSize: '0.8rem', padding: '0.3rem 0.7rem' }}
          onClick={() => void fetchMonitor()}
        >
          刷新
        </button>
      </header>

      {loading && <p className="ui-muted">Loading…</p>}
      {monitorData?.error && (
        <div style={{ background: '#2a1a1a', border: '1px solid #f87171', borderRadius: 8, padding: '0.75rem', marginBottom: '1rem' }}>
          <strong>Error:</strong> {monitorData.error}
        </div>
      )}

      {/* Stats bar */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap: '0.5rem', marginBottom: '1.5rem',
      }}>
        <StatCard label="Master Messages" value={masterCount} />
        <StatCard label="Slave Messages" value={slaveCount} />
      </div>

      {/* Bridge accordion */}
      <div className="ui-bridge-accordion" role="list">
        {(bridges.length > 0 ? bridges : ['default']).map((b) => {
          const dm = daemonStatus[b];
          return (
            <div key={b} className="ui-bridge-accordion-item" role="listitem">
              <div className="ui-bridge-accordion-head" style={{ cursor: 'pointer' }} onClick={() => toggle(b)}>
                <span style={{ marginRight: '0.5rem' }}>{isExpanded(b) ? '▼' : '▶'}</span>
                <code style={{ fontWeight: 600 }}>{b}</code>
                <span style={{ marginLeft: '0.75rem', fontSize: '0.8rem' }} className="ui-muted">
                  Master: {dm?.effectiveRunning ? '🟢' : '⚫'}
                  {' '}Slave: {dm?.slave?.effectiveRunning ? '🟢' : '⚫'}
                </span>
              </div>

              {isExpanded(b) && (
                <div style={{ padding: '1rem 0' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                    <div>
                      <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', color: '#38bdf8' }}>
                        Master Responses ({masterCount})
                      </h3>
                      <MessageList
                        entries={monitorData?.masterOut ?? []}
                        emptyText="No master responses yet"
                        roleTag="master"
                      />
                    </div>
                    <div>
                      <h3 style={{ margin: '0 0 0.75rem', fontSize: '1rem', color: '#a78bfa' }}>
                        Slave Responses ({slaveCount})
                      </h3>
                      <MessageList
                        entries={monitorData?.slaveOut ?? []}
                        emptyText="No slave responses yet"
                        roleTag="slave"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Sub-components ──

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{
      background: '#151f30', border: '1px solid #1e3a5f', borderRadius: 8,
      padding: '0.6rem 0.8rem', textAlign: 'center',
    }}>
      <div className="ui-muted" style={{ fontSize: '0.75rem', marginBottom: '0.25rem' }}>{label}</div>
      <div style={{ fontSize: '1.1rem', fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}

function MessageList({ entries, emptyText, roleTag }: {
  entries: MonitorEntry[];
  emptyText: string;
  roleTag: 'master' | 'slave';
}) {
  const borderColor = roleTag === 'master' ? '#1e3a5f' : '#3b2070';
  const tagColor = roleTag === 'master' ? '#38bdf8' : '#a78bfa';

  if (entries.length === 0) {
    return <p className="ui-muted" style={{ fontSize: '0.85rem' }}>{emptyText}</p>;
  }

  // Show newest first
  const reversed = [...entries].reverse();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '70vh', overflowY: 'auto' }}>
      {reversed.map((entry, i) => (
        <div
          key={`${entry.ts}-${i}`}
          style={{
            background: '#0d1525', border: `1px solid ${borderColor}`, borderRadius: 8,
            padding: '0.6rem 0.8rem', fontSize: '0.85rem', lineHeight: 1.5,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.3rem' }}>
            <span style={{ color: tagColor, fontWeight: 600, fontSize: '0.75rem' }}>
              [{roleTag}] #{entries.length - i}
            </span>
            <span className="ui-muted" style={{ fontSize: '0.7rem' }}>
              {formatTime(entry.ts)}
            </span>
          </div>
          <pre style={{
            margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            fontFamily: 'inherit', fontSize: 'inherit',
          }}>
            {entry.text}
          </pre>
        </div>
      ))}
    </div>
  );
}
