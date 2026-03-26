'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  normalizeRunners,
  type Config,
  type ImInstanceChannel,
  type ImInstanceSpec,
  type RunnerConfig,
} from '../../config-shared';

const IM_INSTANCE_CHANNELS: ImInstanceChannel[] = ['telegram', 'discord', 'feishu', 'qq'];
const RUNTIMES = ['claude', 'codex', 'cursor'] as const;
const RUNNER_MODES = ['code', 'plan', 'ask'] as const;

async function readJsonFromResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const preview = trimmed.slice(0, 280);
    throw new Error(
      res.ok
        ? `服务器返回非 JSON（${preview}${trimmed.length > 280 ? '…' : ''}）`
        : `HTTP ${res.status}: ${preview}${trimmed.length > 280 ? '…' : ''}`,
    );
  }
}

/** From GET /api/bridge/status（桥接为 Next 子进程时 `managedByApp` 为 true）。 */
type EmbeddedBridgeStatus = {
  running?: boolean;
  startedAt?: string | null;
  managedByApp?: boolean;
  adapters?: Array<{ channelType?: string; running?: boolean }>;
};

/** From GET /api/local-config `daemonStatus` (独立守护进程 status.json). */
type DaemonDiskStatus = {
  statusFilePresent: boolean;
  fileSaysRunning: boolean;
  effectiveRunning: boolean;
  stale: boolean;
  pid?: number;
  startedAt?: string;
  runId?: string;
  channels?: string[];
  lastExitReason?: string;
};

/** 机器人「平台」下拉的展示名（与 ImInstanceChannel 一致） */
const IM_CHANNEL_LABELS: Record<ImInstanceChannel, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  feishu: '飞书 / Lark',
  qq: 'QQ',
};

function defaultConfig(): Config {
  return {
    runtime: 'claude',
    enabledChannels: [],
    defaultWorkDir: '',
    defaultMode: 'code',
    autoApprove: false,
    runners: [{ id: 'default', runtime: 'claude', label: '默认' }],
  };
}

/** Local admin state: `imBot: null` is sent in PUT JSON to clear CTI_IM_BOT (undefined is omitted by JSON.stringify). */
type AdminConfig = Omit<Config, 'imBot'> & { imBot?: ImInstanceSpec | null };

function asConfig(c: AdminConfig): Config {
  return { ...c, imBot: c.imBot ?? undefined };
}

function cloneAdminConfig(c: AdminConfig): AdminConfig {
  return JSON.parse(JSON.stringify(c)) as AdminConfig;
}

function adminConfigsEqual(a: AdminConfig, b: AdminConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function AdminPage() {
  const [cfg, setCfg] = useState<AdminConfig>(defaultConfig);
  const [configPath, setConfigPath] = useState('');
  /** Full config + form (can lag behind status query). */
  const [configLoading, setConfigLoading] = useState(true);
  /** First poll for daemon + embedded status finished (may fail silently). */
  const [statusReady, setStatusReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newBridging, setNewBridging] = useState(false);
  const [deletingBridge, setDeletingBridge] = useState(false);
  const [switchingBridge, setSwitchingBridge] = useState(false);
  const [bridges, setBridges] = useState<string[]>([]);
  const [activeBotName, setActiveBotName] = useState('');
  const [canSwitchBridges, setCanSwitchBridges] = useState(false);
  const [daemonStatus, setDaemonStatus] = useState<DaemonDiskStatus | null>(null);
  const [embeddedStatus, setEmbeddedStatus] = useState<EmbeddedBridgeStatus | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** Snapshot after last successful load/save — used to enable Save only when dirty. */
  const [baselineCfg, setBaselineCfg] = useState<AdminConfig | null>(null);

  /** 按当前服务端解析的桥接目录（botName / CTI_HOME）查询独立进程 + Next 内嵌状态。 */
  const pollBridgeStatus = useCallback(async () => {
    try {
      const [cRes, bRes] = await Promise.all([
        fetch('/api/local-config'),
        fetch('/api/bridge/status'),
      ]);
      const cJson = (await readJsonFromResponse(cRes)) as {
        ok?: boolean;
        daemonStatus?: DaemonDiskStatus;
        botName?: string;
        bridges?: string[];
        canSwitchBridges?: boolean;
        error?: string;
      };
      if (cRes.ok && cJson.ok !== false) {
        if (cJson.daemonStatus) setDaemonStatus(cJson.daemonStatus);
        if (typeof cJson.botName === 'string') setActiveBotName(cJson.botName);
        if (Array.isArray(cJson.bridges)) setBridges(cJson.bridges);
        setCanSwitchBridges(cJson.canSwitchBridges === true);
      }
      if (bRes.ok) {
        const b = (await readJsonFromResponse(bRes)) as EmbeddedBridgeStatus;
        setEmbeddedStatus(b);
      } else {
        setEmbeddedStatus(null);
      }
    } catch {
      /* ignore */
    } finally {
      setStatusReady(true);
    }
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setConfigLoading(true);
      setMessage(null);
    }
    try {
      const cRes = await fetch('/api/local-config');
      const cJson = (await readJsonFromResponse(cRes)) as {
        ok?: boolean;
        config?: Config;
        configPath?: string;
        bridges?: string[];
        botName?: string;
        canSwitchBridges?: boolean;
        error?: string;
      };
      if (!cRes.ok || cJson.ok === false) {
        throw new Error(cJson.error || `HTTP ${cRes.status}`);
      }
      if (cJson.config) {
        const merged = { ...defaultConfig(), ...cJson.config };
        if (!merged.runners?.length) {
          merged.runners = [{ id: 'default', runtime: merged.runtime, label: '默认' }];
        }
        setCfg(merged);
        setBaselineCfg(cloneAdminConfig(merged));
      }
      if (cJson.configPath) setConfigPath(cJson.configPath);
      if (Array.isArray(cJson.bridges)) setBridges(cJson.bridges);
      if (typeof cJson.botName === 'string') setActiveBotName(cJson.botName);
      setCanSwitchBridges(cJson.canSwitchBridges === true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      if (!opts?.silent) setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    void pollBridgeStatus();
    void load();
  }, [load, pollBridgeStatus]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void pollBridgeStatus();
    }, 4000);
    return () => window.clearInterval(id);
  }, [pollBridgeStatus]);

  const updateImBot = (patch: Partial<ImInstanceSpec>) => {
    setCfg((prev) => {
      if (!prev.imBot) return prev;
      return { ...prev, imBot: { ...prev.imBot, ...patch } };
    });
  };

  const addImBot = () => {
    setCfg((prev) => {
      const template = normalizeRunners(asConfig(prev)).map((r) => ({ ...r }));
      if (!template.length) {
        template.push({ id: 'default', runtime: prev.runtime, label: '默认' });
      }
      const bridgeId = activeBotName.trim() || 'im';
      const spec: ImInstanceSpec = {
        id: bridgeId,
        channel: 'telegram',
        runners: template,
        defaultRunnerId: template[0]?.id,
      };
      return { ...prev, imBot: spec };
    });
  };

  const updateImRunner = (runnerIdx: number, patch: Partial<RunnerConfig>) => {
    setCfg((prev) => {
      const spec = prev.imBot;
      if (!spec) return prev;
      const runners = [...(spec.runners ?? normalizeRunners(asConfig(prev)))];
      runners[runnerIdx] = { ...runners[runnerIdx], ...patch } as RunnerConfig;
      return { ...prev, imBot: { ...spec, runners } };
    });
  };

  const addImRunner = () => {
    setCfg((prev) => {
      const spec = prev.imBot;
      if (!spec) return prev;
      const runners = [...(spec.runners ?? normalizeRunners(asConfig(prev)))];
      const n = runners.length + 1;
      runners.push({ id: `rt-${n}`, runtime: 'claude', label: `Runner ${n}` });
      return { ...prev, imBot: { ...spec, runners } };
    });
  };

  const removeImRunner = (runnerIdx: number) => {
    setCfg((prev) => {
      const spec = prev.imBot;
      if (!spec) return prev;
      const runners = [...(spec.runners ?? [])].filter((_, i) => i !== runnerIdx);
      return { ...prev, imBot: { ...spec, runners } };
    });
  };

  const saveConfig = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/local-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      const j = (await readJsonFromResponse(res)) as { ok?: boolean; error?: string; configPath?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error || res.statusText);
      if (j.configPath) setConfigPath(j.configPath);
      setMessage(`已写入 ${j.configPath || configPath || 'config.env'}。修改后请按需重启桥接进程或 Next 服务。`);
      await load();
      await pollBridgeStatus();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const bridgeAction = async (action: 'start' | 'stop') => {
    setMessage(null);
    try {
      const res = await fetch(`/api/bridge/${action}`, { method: 'POST' });
      const j = (await readJsonFromResponse(res)) as EmbeddedBridgeStatus & { error?: string };
      if (!res.ok) throw new Error(j.error || res.statusText);
      setEmbeddedStatus(j);
      await pollBridgeStatus();
      setMessage(action === 'start' ? '桥接启动指令已发送。' : '桥接停止指令已发送。');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const switchBridge = async (slug: string) => {
    if (!slug || slug === activeBotName) return;
    setSwitchingBridge(true);
    setMessage(null);
    try {
      const res = await fetch('/api/local-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ switchBridge: slug }),
      });
      const j = (await readJsonFromResponse(res)) as {
        ok?: boolean;
        error?: string;
        configPath?: string;
        botName?: string;
      };
      if (!res.ok || j.ok === false) throw new Error(j.error || res.statusText);
      if (j.configPath) setConfigPath(j.configPath);
      if (j.botName) setActiveBotName(j.botName);
      setStatusReady(false);
      await load({ silent: true });
      await pollBridgeStatus();
      setMessage(`已切换到桥接「${j.botName ?? slug}」。表单已加载该目录下的配置。`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSwitchingBridge(false);
    }
  };

  const createNewBridge = async () => {
    setNewBridging(true);
    setMessage(null);
    try {
      const res = await fetch('/api/local-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newBridge: true }),
      });
      const j = (await readJsonFromResponse(res)) as {
        ok?: boolean;
        error?: string;
        configPath?: string;
        botName?: string;
      };
      if (!res.ok || j.ok === false) throw new Error(j.error || res.statusText);
      if (j.configPath) setConfigPath(j.configPath);
      if (j.botName) setActiveBotName(j.botName);
      setStatusReady(false);
      await load({ silent: true });
      await pollBridgeStatus();
      setMessage(`已新建桥接目录 ${j.botName ?? ''}，配置路径：${j.configPath ?? ''}。表单已重新加载，请按需填写并保存。`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setNewBridging(false);
    }
  };

  const configDirty = useMemo(() => {
    if (baselineCfg === null) return false;
    return !adminConfigsEqual(cfg, baselineCfg);
  }, [cfg, baselineCfg]);

  const bridgeList = useMemo(() => {
    if (bridges.length > 0) return bridges;
    return activeBotName ? [activeBotName] : [];
  }, [bridges, activeBotName]);

  /** When CTI_HOME is fixed, only show the active bridge row (no switching). */
  const displayBridgeList = useMemo(() => {
    if (canSwitchBridges) return bridgeList;
    return activeBotName ? [activeBotName] : bridgeList;
  }, [canSwitchBridges, bridgeList, activeBotName]);

  const handleSelectBridge = (slug: string) => {
    if (slug === activeBotName) return;
    if (configDirty) {
      if (
        !window.confirm(
          '当前有未保存的修改，确定切换到其他桥接？未保存的更改将丢失。',
        )
      ) {
        return;
      }
    }
    void switchBridge(slug);
  };

  const removeBridgeDirectory = async () => {
    if (!activeBotName) return;
    if (
      !window.confirm(
        `确定删除桥接「${activeBotName}」及其目录下全部数据？此操作不可撤销。若删除当前桥接，将切换到其余桥接或新建空目录。`,
      )
    ) {
      return;
    }
    setDeletingBridge(true);
    setMessage(null);
    try {
      const res = await fetch('/api/local-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteBridge: activeBotName }),
      });
      const j = (await readJsonFromResponse(res)) as {
        ok?: boolean;
        error?: string;
        configPath?: string;
        botName?: string;
      };
      if (!res.ok || j.ok === false) throw new Error(j.error || res.statusText);
      if (j.configPath) setConfigPath(j.configPath);
      if (j.botName) setActiveBotName(j.botName);
      setStatusReady(false);
      await load({ silent: true });
      await pollBridgeStatus();
      setMessage(`已删除桥接目录。当前桥接：${j.botName ?? '—'}，配置：${j.configPath ?? ''}。`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingBridge(false);
    }
  };

  /** 磁盘或 API 任一方认为在跑，则视为运行中（用于与「启动」互斥）。 */
  const anyBridgeRunning =
    embeddedStatus?.running === true || daemonStatus?.effectiveRunning === true;
  /** 仅当本应用子进程且 API 确认在跑时，才允许「停止」。 */
  const canStopManagedBridge =
    embeddedStatus?.running === true && embeddedStatus?.managedByApp === true;

  const bridgeActionsLocked =
    !statusReady || saving || newBridging || deletingBridge || switchingBridge;

  const startDisabled = bridgeActionsLocked || configLoading || anyBridgeRunning;
  const stopDisabled = bridgeActionsLocked || configLoading || !canStopManagedBridge;

  let daemonLine = '独立进程：正在查询当前目录下的 status.json / PID…';
  if (statusReady) {
    if (!daemonStatus) {
      daemonLine = '独立进程：暂无状态数据';
    } else if (!daemonStatus.statusFilePresent) {
      daemonLine =
        '独立进程：未发现 status.json（通常表示尚未用 daemon/守护进程在本目录启动过）';
    } else if (daemonStatus.stale) {
      daemonLine =
        '独立进程：状态仍为「运行中」但 PID 已不存在（可重新点「启动桥接」或检查守护进程）';
    } else if (daemonStatus.effectiveRunning) {
      const pidPart = daemonStatus.pid != null ? ` · PID ${daemonStatus.pid}` : '';
      const ch =
        daemonStatus.channels?.length ? ` · 通道 ${daemonStatus.channels.join(', ')}` : '';
      daemonLine = `独立进程：运行中${pidPart}${ch}`;
    } else {
      daemonLine = '独立进程：已停止';
    }
  }

  const childLine = !statusReady
    ? '本应用桥接：查询中…'
    : embeddedStatus?.running === true && embeddedStatus?.managedByApp === true
      ? '本应用桥接：由 Next 以子进程启动；关闭本服务或点「停止」会结束该进程。'
      : embeddedStatus?.running === true && embeddedStatus?.managedByApp !== true
        ? '本应用桥接：当前为外部进程（非本机 Next 子进程）；关闭 Next 不会自动结束，请用 scripts/daemon.sh stop 或结束对应 PID。'
        : '本应用桥接：未运行（点「启动」由 Next 启动子进程）。';

  return (
    <main className="page-shell ui-admin">
      <header
        className="ui-admin-header"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: '1rem',
        }}
      >
        <div>
          <p className="eyebrow">本机管理</p>
          <h1 style={{ marginBottom: '0.5rem' }}>桥接与平台</h1>
          <nav className="ui-nav">
            <a href="/">首页</a>
            <a href="/board">任务看板</a>
            <a href="/health">健康检查</a>
          </nav>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="ui-btn secondary"
              disabled={saving || newBridging || deletingBridge || switchingBridge}
              onClick={() => void createNewBridge()}
            >
              {newBridging ? '正在新建…' : '新建桥接'}
            </button>
          </div>
        </div>
      </header>

      {message ? <p className="ui-banner">{message}</p> : null}

      <section className="ui-section hero-card">
        <h2>Bridge（桥接）</h2>
        <div
          className="ui-bridge-status"
          style={{
            marginBottom: '1rem',
            padding: '0.75rem 1rem',
            borderRadius: '8px',
            border: '1px solid var(--ui-border, #333)',
            background: 'rgba(148, 163, 184, 0.08)',
          }}
        >
          <p style={{ margin: 0, fontSize: '0.95rem' }}>
            <strong>当前桥接</strong> · <code>{activeBotName || '—'}</code>
          </p>
          <p className="ui-muted ui-small" style={{ margin: '0.4rem 0 0' }}>
            {daemonLine}
          </p>
          <p className="ui-muted ui-small" style={{ margin: '0.25rem 0 0' }}>
            {childLine}
          </p>
        </div>
        {configLoading ? (
          <p className="ui-muted">正在加载配置表单…</p>
        ) : (
        <div className="ui-bridge-subsection">
        <h3 style={{ marginTop: 0, marginBottom: '0.75rem', fontSize: '1.1rem' }}>桥接目录</h3>
        {displayBridgeList.length === 0 ? (
          <p className="ui-muted ui-small">暂无桥接目录。</p>
        ) : (
          <div className="ui-bridge-accordion" role="list">
            {displayBridgeList.map((b) => {
              const showAccordionSwitch = canSwitchBridges && displayBridgeList.length > 1;
              return (
              <div
                key={b}
                className={`ui-bridge-accordion-item${activeBotName === b ? ' is-active' : ''}`}
                role="listitem"
              >
                {showAccordionSwitch ? (
                  <button
                    type="button"
                    className="ui-bridge-accordion-trigger"
                    aria-expanded={activeBotName === b}
                    aria-controls={`admin-bridge-panel-${b}`}
                    id={`admin-bridge-head-${b}`}
                    disabled={switchingBridge || newBridging || deletingBridge}
                    onClick={() => handleSelectBridge(b)}
                  >
                    <span className="ui-bridge-accordion-chevron" aria-hidden>
                      {activeBotName === b ? '▼' : '▶'}
                    </span>
                    <code>{b}</code>
                    {activeBotName === b ? (
                      <span className="ui-bridge-accordion-badge">当前</span>
                    ) : null}
                  </button>
                ) : (
                  <div
                    className="ui-bridge-accordion-trigger ui-bridge-accordion-trigger-static"
                    id={`admin-bridge-head-${b}`}
                  >
                    <span className="ui-bridge-accordion-chevron" aria-hidden>
                      ▼
                    </span>
                    <code>{b}</code>
                    <span className="ui-bridge-accordion-badge">当前</span>
                  </div>
                )}
                {activeBotName === b ? (
                  <div
                    className="ui-bridge-accordion-panel"
                    id={`admin-bridge-panel-${b}`}
                    role="region"
                    aria-labelledby={`admin-bridge-head-${b}`}
                  >
        <div className="ui-section-title">
          <h3>IM 机器人（CTI_IM_BOT）</h3>
          {!cfg.imBot ? (
            <button type="button" className="ui-btn secondary" onClick={addImBot}>
              添加机器人
            </button>
          ) : null}
        </div>
        <p className="ui-muted ui-small">
          会话绑定里的 channelType 形如 <code>telegram:你的-id</code>。未使用 <code>CTI_IM_BOT</code> 时仍可依赖顶格{' '}
          <code>CTI_TG_BOT_TOKEN</code> 等字段（可直接编辑 config.env）。
        </p>
        {!cfg.imBot ? (
          <p className="ui-muted ui-small">尚未配置机器人：请点击「添加机器人」。</p>
        ) : (
          <div className="ui-stack">
            {(() => {
              const spec = cfg.imBot;
              return (
              <div key="im-bot" className="ui-card" style={{ padding: '1rem', border: '1px solid var(--ui-border, #333)' }}>
                <div className="ui-grid" style={{ alignItems: 'flex-end' }}>
                  <div className="ui-field">
                    <span>桥接实例标识（路由与存储）</span>
                    <p className="ui-muted ui-small" style={{ margin: '0.35rem 0 0' }}>
                      与当前桥接目录名一致，保存时由服务端写入 <code>CTI_IM_BOT.id</code>：
                      <code>{activeBotName || '—'}</code>
                    </p>
                  </div>
                  <label className="ui-field">
                    <span>平台</span>
                    <select
                      value={spec.channel}
                      onChange={(e) =>
                        updateImBot({ channel: e.target.value as ImInstanceChannel })
                      }
                    >
                      {IM_INSTANCE_CHANNELS.map((c) => (
                        <option key={c} value={c}>
                          {IM_CHANNEL_LABELS[c]}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {spec.channel === 'telegram' ? (
                  <div className="ui-grid" style={{ marginTop: '0.75rem' }}>
                    <label className="ui-field">
                      <span>tgBotToken</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={spec.tgBotToken ?? ''}
                        onChange={(e) => updateImBot({ tgBotToken: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>tgChatId</span>
                      <input
                        value={spec.tgChatId ?? ''}
                        onChange={(e) => updateImBot({ tgChatId: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>tgAllowedUsers（逗号分隔）</span>
                      <input
                        value={spec.tgAllowedUsers?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImBot({
                            tgAllowedUsers: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                  </div>
                ) : null}
                {spec.channel === 'discord' ? (
                  <div className="ui-grid" style={{ marginTop: '0.75rem' }}>
                    <label className="ui-field">
                      <span>discordBotToken</span>
                      <input
                        type="password"
                        value={spec.discordBotToken ?? ''}
                        onChange={(e) =>
                          updateImBot({ discordBotToken: e.target.value || undefined })
                        }
                      />
                    </label>
                    <label className="ui-field">
                      <span>允许的用户 ID（逗号）</span>
                      <input
                        value={spec.discordAllowedUsers?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImBot({
                            discordAllowedUsers: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <label className="ui-field">
                      <span>允许的频道（逗号）</span>
                      <input
                        value={spec.discordAllowedChannels?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImBot({
                            discordAllowedChannels: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <label className="ui-field">
                      <span>允许的服务器（逗号）</span>
                      <input
                        value={spec.discordAllowedGuilds?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImBot({
                            discordAllowedGuilds: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                  </div>
                ) : null}
                {spec.channel === 'feishu' ? (
                  <div className="ui-grid" style={{ marginTop: '0.75rem' }}>
                    <label className="ui-field">
                      <span>feishuAppId</span>
                      <input
                        value={spec.feishuAppId ?? ''}
                        onChange={(e) => updateImBot({ feishuAppId: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>feishuAppSecret</span>
                      <input
                        type="password"
                        value={spec.feishuAppSecret ?? ''}
                        onChange={(e) =>
                          updateImBot({ feishuAppSecret: e.target.value || undefined })
                        }
                      />
                    </label>
                    <label className="ui-field">
                      <span>feishuDomain</span>
                      <input
                        value={spec.feishuDomain ?? ''}
                        onChange={(e) => updateImBot({ feishuDomain: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>允许的用户（逗号）</span>
                      <input
                        value={spec.feishuAllowedUsers?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImBot({
                            feishuAllowedUsers: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                  </div>
                ) : null}
                {spec.channel === 'qq' ? (
                  <div className="ui-grid" style={{ marginTop: '0.75rem' }}>
                    <label className="ui-field">
                      <span>qqAppId</span>
                      <input
                        value={spec.qqAppId ?? ''}
                        onChange={(e) => updateImBot({ qqAppId: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>qqAppSecret</span>
                      <input
                        type="password"
                        value={spec.qqAppSecret ?? ''}
                        onChange={(e) => updateImBot({ qqAppSecret: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>允许的用户（逗号）</span>
                      <input
                        value={spec.qqAllowedUsers?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImBot({
                            qqAllowedUsers: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <label className="ui-field ui-check">
                      <input
                        type="checkbox"
                        checked={spec.qqImageEnabled !== false}
                        onChange={(e) => updateImBot({ qqImageEnabled: e.target.checked })}
                      />
                      <span>qqImageEnabled</span>
                    </label>
                    <label className="ui-field">
                      <span>qqMaxImageSize</span>
                      <input
                        type="number"
                        value={spec.qqMaxImageSize ?? ''}
                        onChange={(e) =>
                          updateImBot({
                            qqMaxImageSize: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                      />
                    </label>
                  </div>
                ) : null}
                <h4
                  style={{
                    marginTop: '1rem',
                    marginBottom: '0.5rem',
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    color: '#cbd5e1',
                  }}
                >
                  桥接默认值（写入顶格 CTI_*）
                </h4>
                <div className="ui-grid">
                  <label className="ui-field">
                    <span>默认工作目录（CTI_DEFAULT_WORKDIR）</span>
                    <input
                      value={spec.defaultWorkDir ?? ''}
                      onChange={(e) => updateImBot({ defaultWorkDir: e.target.value || undefined })}
                    />
                  </label>
                  <label className="ui-field">
                    <span>HTTP 代理（CTI_PROXY）</span>
                    <input
                      value={spec.proxy ?? ''}
                      onChange={(e) => updateImBot({ proxy: e.target.value || undefined })}
                    />
                  </label>
                  <label className="ui-field ui-check">
                    <input
                      type="checkbox"
                      checked={!!spec.autoApprove}
                      onChange={(e) => updateImBot({ autoApprove: e.target.checked })}
                    />
                    <span>自动批准工具（CTI_AUTO_APPROVE）</span>
                  </label>
                </div>
                <p className="ui-muted ui-small" style={{ marginTop: '0.5rem' }}>
                  默认模型与模式（code / plan / ask）由各 Runner 单独配置；不再使用桥接级 CTI_DEFAULT_MODEL / CTI_DEFAULT_MODE。
                </p>
                <div
                  style={{
                    marginTop: '0.75rem',
                    borderTop: '1px solid var(--ui-border, #333)',
                    paddingTop: '0.75rem',
                  }}
                >
                  <p className="ui-muted ui-small">
                    <strong>Runners</strong>（<code>imBot.runners</code>，保存时同步 <code>CTI_RUNNERS</code>）
                  </p>
                  <label className="ui-field">
                    <span>此 bot 默认 Runner</span>
                    <select
                      value={spec.defaultRunnerId ?? (spec.runners?.[0]?.id ?? '')}
                      onChange={(e) => updateImBot({ defaultRunnerId: e.target.value || undefined })}
                    >
                      {(spec.runners ?? normalizeRunners(asConfig(cfg))).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.id}（{r.runtime}）
                        </option>
                      ))}
                    </select>
                  </label>
                  {(spec.runners ?? normalizeRunners(asConfig(cfg))).map((prof, ridx) => (
                    <div key={`${ridx}-${prof.id}`} className="ui-slot" style={{ marginTop: '0.5rem' }}>
                      <div className="ui-slot-head">
                        <strong>Runner</strong>
                        <button type="button" className="ui-btn ghost" onClick={() => removeImRunner(ridx)}>
                          删除
                        </button>
                      </div>
                      <div className="ui-grid">
                        <label className="ui-field">
                          <span>Runner ID</span>
                          <input
                            value={prof.id}
                            onChange={(e) => updateImRunner(ridx, { id: e.target.value })}
                          />
                        </label>
                        <label className="ui-field">
                          <span>显示名称</span>
                          <input
                            value={prof.label ?? ''}
                            onChange={(e) => updateImRunner(ridx, { label: e.target.value || undefined })}
                          />
                        </label>
                        <label className="ui-field">
                          <span>后端类型</span>
                          <select
                            value={prof.runtime}
                            onChange={(e) =>
                              updateImRunner(ridx, { runtime: e.target.value as RunnerConfig['runtime'] })
                            }
                          >
                            {RUNTIMES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="ui-field">
                          <span>默认模型（可选）</span>
                          <input
                            value={prof.defaultModel ?? ''}
                            onChange={(e) =>
                              updateImRunner(ridx, { defaultModel: e.target.value || undefined })
                            }
                          />
                        </label>
                        <label className="ui-field">
                          <span>建议模式</span>
                          <select
                            value={prof.defaultMode ?? ''}
                            onChange={(e) => {
                              const v = e.target.value;
                              updateImRunner(ridx, {
                                defaultMode: v === 'code' || v === 'plan' || v === 'ask' ? v : undefined,
                              });
                            }}
                          >
                            <option value="">（未设置）</option>
                            {RUNNER_MODES.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="ui-field">
                          <span>自动批准工具</span>
                          <select
                            value={prof.autoApprove === undefined ? '' : prof.autoApprove ? 'yes' : 'no'}
                            onChange={(e) => {
                              const v = e.target.value;
                              updateImRunner(ridx, {
                                autoApprove: v === '' ? undefined : v === 'yes',
                              });
                            }}
                          >
                            <option value="">继承桥接默认</option>
                            <option value="yes">是</option>
                            <option value="no">否</option>
                          </select>
                        </label>
                      </div>
                      {prof.runtime === 'claude' && (
                        <div
                          className="ui-grid"
                          style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }}
                        >
                          <label className="ui-field">
                            <span>Claude CLI 路径</span>
                            <input
                              value={prof.claudeExecutable ?? ''}
                              onChange={(e) =>
                                updateImRunner(ridx, { claudeExecutable: e.target.value || undefined })
                              }
                            />
                          </label>
                        </div>
                      )}
                      {prof.runtime === 'codex' && (
                        <div
                          className="ui-grid"
                          style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }}
                        >
                          <label className="ui-field">
                            <span>Codex wrapper 路径</span>
                            <input
                              value={prof.codexExecutable ?? ''}
                              onChange={(e) =>
                                updateImRunner(ridx, { codexExecutable: e.target.value || undefined })
                              }
                            />
                          </label>
                          <label className="ui-field ui-check">
                            <input
                              type="checkbox"
                              checked={prof.codexUseLogin === true}
                              onChange={(e) =>
                                updateImRunner(ridx, { codexUseLogin: e.target.checked ? true : undefined })
                              }
                            />
                            <span>Codex 使用 CLI login</span>
                          </label>
                        </div>
                      )}
                      {prof.runtime === 'cursor' && (
                        <div
                          className="ui-grid"
                          style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }}
                        >
                          <label className="ui-field">
                            <span>Cursor agent 路径</span>
                            <input
                              value={prof.cursorExecutable ?? ''}
                              onChange={(e) =>
                                updateImRunner(ridx, { cursorExecutable: e.target.value || undefined })
                              }
                            />
                          </label>
                        </div>
                      )}
                    </div>
                  ))}
                  <button type="button" className="ui-btn secondary" style={{ marginTop: '0.5rem' }} onClick={() => addImRunner()}>
                    添加 Runner
                  </button>
                </div>
                <div
                  style={{
                    marginTop: '1rem',
                    borderTop: '1px solid var(--ui-border, #333)',
                    paddingTop: '0.75rem',
                  }}
                >
                  <p className="ui-muted ui-small">
                    <strong>Local Agent</strong>：勾选后该 bot 不再走上方平台 API；仅在此模式下连接 Redis（普通频道不会用 Redis）。
                    Runner 从 <code>input</code> 取用户文本，回复写入 <code>out</code>，可转发到同平台另一实例的{' '}
                    <code>input</code>。键前缀：<code>cti:localagent:平台:实例id:</code>。下方 Redis URL 为<strong>必填</strong>
                    （不使用全局 <code>CTI_AGENT_REDIS_URL</code>）。
                  </p>
                  <div className="ui-grid">
                    <label className="ui-field ui-check">
                      <input
                        type="checkbox"
                        checked={!!spec.localAgentEnabled}
                        onChange={(e) =>
                          updateImBot({ localAgentEnabled: e.target.checked ? true : false })
                        }
                      />
                      <span>启用 Local Agent</span>
                    </label>
                  </div>
                  {spec.localAgentEnabled ? (
                    <div className="ui-grid">
                      <label className="ui-field">
                        <span>Redis URL（必填）</span>
                        <input
                          value={spec.localAgentRedisUrl ?? ''}
                          onChange={(e) =>
                            updateImBot({ localAgentRedisUrl: e.target.value || undefined })
                          }
                          placeholder="redis://127.0.0.1:6379"
                          required
                        />
                      </label>
                      <label className="ui-field">
                        <span>首条入队文本（LPUSH 到 input）</span>
                        <input
                          value={spec.localAgentFirstPrompt ?? ''}
                          onChange={(e) =>
                            updateImBot({ localAgentFirstPrompt: e.target.value || undefined })
                          }
                        />
                      </label>
                      <label className="ui-field">
                        <span>最大轮次</span>
                        <input
                          type="number"
                          min={1}
                          value={spec.localAgentMaxTurns ?? ''}
                          onChange={(e) =>
                            updateImBot({
                              localAgentMaxTurns: e.target.value ? Number(e.target.value) : undefined,
                            })
                          }
                        />
                      </label>
                      <label className="ui-field">
                        <span>Peer 实例 id（可选，同平台）</span>
                        <input
                          value={spec.localAgentPeerInstanceId ?? ''}
                          onChange={(e) =>
                            updateImBot({
                              localAgentPeerInstanceId: e.target.value.trim() || undefined,
                            })
                          }
                          placeholder="另一 bot 的 slug，转发 Claude 回复到其 input"
                        />
                      </label>
                    </div>
                  ) : null}
                </div>
              </div>
            );})()}
          </div>
        )}
        <p className="ui-muted ui-small" style={{ marginTop: '1rem' }}>
          写入配置中的 CTI_RUNTIME（当前生效值）：<code>{cfg.runtime}</code>
        </p>
        <div
          className="ui-actions-bar ui-bridge-panel-actions"
          style={{
            marginTop: '1.25rem',
            paddingTop: '1rem',
            borderTop: '1px solid var(--ui-border, #333)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.75rem',
            alignItems: 'flex-end',
          }}
        >
          {!canSwitchBridges ? (
            <p className="ui-muted ui-small" style={{ margin: 0, flex: '1 1 200px' }}>
              已设置 <code>CTI_HOME</code> 时由环境固定目录，无法在此切换多个桥接；未设置时可在上方折叠行切换。
            </p>
          ) : (
            <p className="ui-muted ui-small" style={{ margin: 0, flex: '1 1 200px' }}>
              切换其他桥接前若有未保存修改将提示确认。
            </p>
          )}
          <button
            type="button"
            className="ui-btn primary"
            disabled={
              !configDirty ||
              configLoading ||
              saving ||
              newBridging ||
              deletingBridge ||
              switchingBridge
            }
            onClick={() => void saveConfig()}
            title={!configDirty ? '没有变更' : undefined}
          >
            {saving ? '保存中…' : '保存 config.env'}
          </button>
          <button type="button" className="ui-btn secondary" disabled={startDisabled} onClick={() => void bridgeAction('start')}>
            启动桥接
          </button>
          <button type="button" className="ui-btn secondary" disabled={stopDisabled} onClick={() => void bridgeAction('stop')}>
            停止桥接
          </button>
          {canSwitchBridges ? (
            <button
              type="button"
              className="ui-btn secondary"
              disabled={
                saving || newBridging || deletingBridge || switchingBridge || !activeBotName
              }
              onClick={() => void removeBridgeDirectory()}
            >
              {deletingBridge ? '正在删除…' : '删除桥接'}
            </button>
          ) : null}
        </div>
                  </div>
                ) : null}
              </div>
            );
            })}
          </div>
        )}
        </div>
        )}
      </section>
    </main>
  );
}
