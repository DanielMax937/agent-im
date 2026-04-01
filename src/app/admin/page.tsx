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
const RUNTIMES = ['claude', 'codex', 'cursor', 'copilot'] as const;
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

/** Avoid browser / CDN reusing one response for different `?slug=` queries. */
const fetchNoStore: RequestInit = { cache: 'no-store' };

/**
 * 1) List slugs from GET /api/local-config
 * 2) For each slug, GET /api/bridge/status?slug= (sequential)
 * 3) Repeat step 2 once so status.json / child PID settle after start/stop
 */
async function fetchEmbeddedStatusesSequential(
  slugs: string[],
): Promise<Record<string, EmbeddedBridgeStatus>> {
  const emb: Record<string, EmbeddedBridgeStatus> = {};
  for (const slug of slugs) {
    const r = await fetch(
      `/api/bridge/status?slug=${encodeURIComponent(slug)}`,
      fetchNoStore,
    );
    if (r.ok) {
      emb[slug] = (await readJsonFromResponse(r)) as EmbeddedBridgeStatus;
    }
  }
  return emb;
}

async function fetchEmbeddedStatusesVerify(
  slugs: string[],
): Promise<Record<string, EmbeddedBridgeStatus>> {
  await fetchEmbeddedStatusesSequential(slugs);
  return fetchEmbeddedStatusesSequential(slugs);
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
  slave?: {
    running: boolean;
    effectiveRunning: boolean;
    pid?: number;
    startedAt?: string;
    lastExitReason?: string;
  };
};

type EnvPresence = Record<string, boolean>;

/** 机器人「平台」下拉的展示名（与 ImInstanceChannel 一致） */
const IM_CHANNEL_LABELS: Record<ImInstanceChannel, string> = {
  telegram: 'Telegram',
  discord: 'Discord',
  feishu: '飞书 / Lark',
  qq: 'QQ',
};

/** Slug for the Kanban platform data dir — IM bridge start/stop/delete are managed elsewhere. */
const KANBAN_BRIDGE_SLUG = 'kanban';

function defaultConfig(): Config {
  return {
    runtime: 'claude',
    enabledChannels: [],
    defaultWorkDir: '',
    defaultMode: 'code',
    autoApprove: false,
    autoLogStreamChunks: true,
    runners: [{ id: 'default', runtime: 'claude', label: '默认' }],
  };
}

function summarizeAutoMode(config: AdminConfig, bridgeSlug: string) {
  const spec = config.imBot;
  if (!spec?.autoMode) {
    return {
      enabled: false,
      modeLabel: '关闭',
      namespace: bridgeSlug,
      slaveRunnerId: null as string | null,
      consumerLabel: null as string | null,
    };
  }

  const namespace = spec.autoRedisNamespace?.trim() || bridgeSlug;
  const slaveRunnerId =
    spec.autoSlaveRunner?.id?.trim() ||
    spec.defaultRunnerId?.trim() ||
    spec.runners?.[0]?.id ||
    'default';

  return {
    enabled: true,
    modeLabel: 'Hybrid (Telegram + Redis)',
    namespace,
    slaveRunnerId,
    consumerLabel: 'Master / Slave 为独立桥接进程',
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

function envPresent(envPresence: EnvPresence, key: string): boolean {
  return envPresence[key] === true;
}

function EnvCheckRow({
  name,
  exists,
  optional = false,
}: {
  name: string;
  exists: boolean;
  optional?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: '0.75rem',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      }}
    >
      <span>{name}{optional ? '（可选）' : ''}</span>
      <span style={{ color: exists ? '#86efac' : optional ? '#94a3b8' : '#fca5a5' }}>
        {exists ? 'exists' : optional ? 'missing' : 'missing'}
      </span>
    </div>
  );
}

function RunnerEnvTip({
  runner,
  envPresence,
}: {
  runner: RunnerConfig;
  envPresence: EnvPresence;
}) {
  if (runner.runtime === 'claude' && runner.claudeUseLogin !== true) {
    const hasPrimary =
      envPresent(envPresence, 'ANTHROPIC_API_KEY') ||
      envPresent(envPresence, 'ANTHROPIC_AUTH_TOKEN');
    return (
      <div
        style={{
          marginTop: '0.5rem',
          padding: '0.75rem 0.9rem',
          border: '1px solid #334155',
          borderRadius: '0.75rem',
          background: '#0f172a',
        }}
      >
        <p className="ui-muted ui-small" style={{ margin: 0 }}>
          Claude API 模式会读取当前服务进程环境变量。需要至少一个主凭证：
          <code>ANTHROPIC_API_KEY</code> 或 <code>ANTHROPIC_AUTH_TOKEN</code>；
          自定义网关可再提供 <code>ANTHROPIC_BASE_URL</code>。
        </p>
        <div style={{ marginTop: '0.55rem' }}>
          <EnvCheckRow name="ANTHROPIC_API_KEY" exists={envPresent(envPresence, 'ANTHROPIC_API_KEY')} />
          <EnvCheckRow name="ANTHROPIC_AUTH_TOKEN" exists={envPresent(envPresence, 'ANTHROPIC_AUTH_TOKEN')} />
          <EnvCheckRow name="ANTHROPIC_BASE_URL" exists={envPresent(envPresence, 'ANTHROPIC_BASE_URL')} optional />
        </div>
        <p className="ui-small" style={{ margin: '0.55rem 0 0', color: hasPrimary ? '#86efac' : '#fca5a5' }}>
          {hasPrimary ? '主凭证已找到。' : '未找到 Claude 主凭证，关闭 CLI login 后仍无法用 API 模式。'}
        </p>
      </div>
    );
  }

  if (runner.runtime === 'codex' && runner.codexUseLogin !== true) {
    const hasPrimary =
      envPresent(envPresence, 'CTI_CODEX_API_KEY') ||
      envPresent(envPresence, 'CODEX_API_KEY') ||
      envPresent(envPresence, 'OPENAI_API_KEY');
    return (
      <div
        style={{
          marginTop: '0.5rem',
          padding: '0.75rem 0.9rem',
          border: '1px solid #334155',
          borderRadius: '0.75rem',
          background: '#0f172a',
        }}
      >
        <p className="ui-muted ui-small" style={{ margin: 0 }}>
          Codex API 模式按顺序读取 <code>CTI_CODEX_API_KEY</code>、<code>CODEX_API_KEY</code>、
          <code>OPENAI_API_KEY</code>；自定义网关使用 <code>CTI_CODEX_BASE_URL</code>。
        </p>
        <div style={{ marginTop: '0.55rem' }}>
          <EnvCheckRow name="CTI_CODEX_API_KEY" exists={envPresent(envPresence, 'CTI_CODEX_API_KEY')} />
          <EnvCheckRow name="CODEX_API_KEY" exists={envPresent(envPresence, 'CODEX_API_KEY')} />
          <EnvCheckRow name="OPENAI_API_KEY" exists={envPresent(envPresence, 'OPENAI_API_KEY')} />
          <EnvCheckRow name="CTI_CODEX_BASE_URL" exists={envPresent(envPresence, 'CTI_CODEX_BASE_URL')} optional />
        </div>
        <p className="ui-small" style={{ margin: '0.55rem 0 0', color: hasPrimary ? '#86efac' : '#fca5a5' }}>
          {hasPrimary ? '主凭证已找到。' : '未找到 Codex 主凭证，关闭 CLI login 后将无法走 API 模式。'}
        </p>
      </div>
    );
  }

  return null;
}

export default function AdminPage() {
  /** Per bridge slug — loaded from GET /api/local-config `configsByBridge`. */
  const [bridgeConfigs, setBridgeConfigs] = useState<Record<string, AdminConfig>>({});
  const [configPath, setConfigPath] = useState('');
  /** Full config + form (can lag behind status query). */
  const [configLoading, setConfigLoading] = useState(true);
  /** First poll for daemon + embedded status finished (may fail silently). */
  const [statusReady, setStatusReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [newBridging, setNewBridging] = useState(false);
  const [deletingBridge, setDeletingBridge] = useState(false);
  const [bridges, setBridges] = useState<string[]>([]);
  const [activeBotName, setActiveBotName] = useState('');
  const [canSwitchBridges, setCanSwitchBridges] = useState(false);
  const [daemonStatusByBridge, setDaemonStatusByBridge] = useState<Record<string, DaemonDiskStatus>>({});
  const [embeddedByBridge, setEmbeddedByBridge] = useState<Record<string, EmbeddedBridgeStatus>>({});
  const [envPresence, setEnvPresence] = useState<EnvPresence>({});
  const [message, setMessage] = useState<string | null>(null);
  /** Snapshot after last successful load/save — dirty detection per bridge. */
  const [baselineBridgeConfigs, setBaselineBridgeConfigs] = useState<Record<string, AdminConfig> | null>(null);
  /** Per-bridge accordion: expanded unless explicitly set to false (default expanded). */
  const [bridgePanelExpanded, setBridgePanelExpanded] = useState<Record<string, boolean>>({});

  const isBridgePanelExpanded = useCallback((slug: string) => bridgePanelExpanded[slug] !== false, [bridgePanelExpanded]);

  const toggleBridgePanelExpanded = useCallback((slug: string) => {
    setBridgePanelExpanded((prev) => {
      const cur = prev[slug] !== false;
      return { ...prev, [slug]: !cur };
    });
  }, []);

  /** 不覆盖表单：只同步 bridges 列表、默认桥接名、磁盘 daemon、以及按 slug 拉两次子进程状态。 */
  const pollBridgeStatus = useCallback(async () => {
    try {
      const cRes = await fetch('/api/local-config', fetchNoStore);
      const cJson = (await readJsonFromResponse(cRes)) as {
        ok?: boolean;
        daemonStatusByBridge?: Record<string, DaemonDiskStatus>;
        envPresence?: EnvPresence;
        botName?: string;
        bridges?: string[];
        canSwitchBridges?: boolean;
        error?: string;
      };
      if (cRes.ok && cJson.ok !== false) {
        if (cJson.daemonStatusByBridge && typeof cJson.daemonStatusByBridge === 'object') {
          setDaemonStatusByBridge(cJson.daemonStatusByBridge);
        }
        if (cJson.envPresence && typeof cJson.envPresence === 'object') {
          setEnvPresence(cJson.envPresence);
        }
        if (typeof cJson.botName === 'string') setActiveBotName(cJson.botName);
        if (Array.isArray(cJson.bridges)) setBridges(cJson.bridges);
        setCanSwitchBridges(cJson.canSwitchBridges === true);
        const slugs = Array.isArray(cJson.bridges) ? cJson.bridges : [];
        const emb = await fetchEmbeddedStatusesVerify(slugs);
        setEmbeddedByBridge(emb);
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
      const cRes = await fetch('/api/local-config', fetchNoStore);
      const cJson = (await readJsonFromResponse(cRes)) as {
        ok?: boolean;
        config?: Config;
        configsByBridge?: Record<string, Config>;
        configPath?: string;
        bridges?: string[];
        botName?: string;
        canSwitchBridges?: boolean;
        daemonStatusByBridge?: Record<string, DaemonDiskStatus>;
        envPresence?: EnvPresence;
        error?: string;
      };
      if (!cRes.ok || cJson.ok === false) {
        throw new Error(cJson.error || `HTTP ${cRes.status}`);
      }
      if (cJson.configsByBridge && typeof cJson.configsByBridge === 'object') {
        const next: Record<string, AdminConfig> = {};
        for (const [slug, raw] of Object.entries(cJson.configsByBridge)) {
          const merged = { ...defaultConfig(), ...raw };
          if (!merged.runners?.length) {
            merged.runners = [{ id: 'default', runtime: merged.runtime, label: '默认' }];
          }
          next[slug] = merged;
        }
        setBridgeConfigs(next);
        setBaselineBridgeConfigs(JSON.parse(JSON.stringify(next)) as Record<string, AdminConfig>);
      } else if (cJson.config) {
        const merged = { ...defaultConfig(), ...cJson.config };
        if (!merged.runners?.length) {
          merged.runners = [{ id: 'default', runtime: merged.runtime, label: '默认' }];
        }
        const bot = cJson.botName ?? 'default';
        setBridgeConfigs({ [bot]: merged });
        setBaselineBridgeConfigs({ [bot]: cloneAdminConfig(merged) });
      }
      if (cJson.configPath) setConfigPath(cJson.configPath);
      if (Array.isArray(cJson.bridges)) setBridges(cJson.bridges);
      if (typeof cJson.botName === 'string') setActiveBotName(cJson.botName);
      setCanSwitchBridges(cJson.canSwitchBridges === true);
      if (cJson.daemonStatusByBridge && typeof cJson.daemonStatusByBridge === 'object') {
        setDaemonStatusByBridge(cJson.daemonStatusByBridge);
      }
      if (cJson.envPresence && typeof cJson.envPresence === 'object') {
        setEnvPresence(cJson.envPresence);
      }
      const slugs = Array.isArray(cJson.bridges) ? cJson.bridges : [];
      const emb = await fetchEmbeddedStatusesVerify(slugs);
      setEmbeddedByBridge(emb);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setStatusReady(true);
      if (!opts?.silent) setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void pollBridgeStatus();
    }, 4000);
    return () => window.clearInterval(id);
  }, [pollBridgeStatus]);

  const saveBridgeConfig = async (slug: string) => {
    const payload = bridgeConfigs[slug];
    if (!payload) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/local-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetBridge: slug, ...payload }),
        ...fetchNoStore,
      });
      const j = (await readJsonFromResponse(res)) as { ok?: boolean; error?: string; configPath?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error || res.statusText);
      if (j.configPath) setConfigPath(j.configPath);
      setMessage(`已写入「${slug}」${j.configPath || ''}。修改后请按需重启该桥接或 Next 服务。`);
      await load({ silent: true });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const saveSlaveEnvForBridge = async (slug: string) => {
    setSaving(true);
    setMessage(null);
    try {
      // First save the main config so slave runner fields are persisted
      const payload = bridgeConfigs[slug];
      if (payload) {
        const saveRes = await fetch('/api/local-config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetBridge: slug, ...payload }),
          ...fetchNoStore,
        });
        const saveJ = (await readJsonFromResponse(saveRes)) as { ok?: boolean; error?: string };
        if (!saveRes.ok || saveJ.ok === false) throw new Error(saveJ.error || saveRes.statusText);
      }
      // Then generate config.slave.env from the saved slave runner config
      const res = await fetch('/api/local-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetBridge: slug, saveSlaveEnv: true }),
        ...fetchNoStore,
      });
      const j = (await readJsonFromResponse(res)) as { ok?: boolean; error?: string; configPath?: string };
      if (!res.ok || j.ok === false) throw new Error(j.error || res.statusText);
      setMessage(`已保存 config.slave.env → ${j.configPath || ''}。重启桥接后生效。`);
      await load({ silent: true });
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const bridgeAction = async (action: 'start' | 'stop', slug: string) => {
    setMessage(null);
    try {
      const res = await fetch(`/api/bridge/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
        ...fetchNoStore,
      });
      const j = (await readJsonFromResponse(res)) as EmbeddedBridgeStatus & { error?: string };
      if (!res.ok) throw new Error(j.error || res.statusText);
      await pollBridgeStatus();
      setMessage(action === 'start' ? `桥接「${slug}」启动指令已发送。` : `桥接「${slug}」停止指令已发送。`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
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
        ...fetchNoStore,
      });
      const j = (await readJsonFromResponse(res)) as {
        ok?: boolean;
        error?: string;
        configPath?: string;
        botName?: string;
      };
      if (!res.ok || j.ok === false) throw new Error(j.error || res.statusText);
      if (j.configPath) setConfigPath(j.configPath);
      if (j.botName) {
        setActiveBotName(j.botName);
        setBridgePanelExpanded((prev) => ({ ...prev, [j.botName!]: true }));
      }
      setStatusReady(false);
      await load({ silent: true });
      setMessage(`已新建桥接目录 ${j.botName ?? ''}，配置路径：${j.configPath ?? ''}。表单已重新加载，请按需填写并保存。`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setNewBridging(false);
    }
  };

  const bridgeList = useMemo(() => {
    if (bridges.length > 0) return bridges;
    return activeBotName ? [activeBotName] : [];
  }, [bridges, activeBotName]);

  /** When CTI_HOME is fixed, only show the active bridge row (no switching). */
  const displayBridgeList = useMemo(() => {
    if (canSwitchBridges) return bridgeList;
    return activeBotName ? [activeBotName] : bridgeList;
  }, [canSwitchBridges, bridgeList, activeBotName]);

  const removeBridgeDirectory = async (slug: string) => {
    if (!slug) return;
    if (
      !window.confirm(
        `确定删除桥接「${slug}」及其目录下全部数据？此操作不可撤销。若删除的是当前默认桥接，将切换到其余桥接或新建空目录。`,
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
        body: JSON.stringify({ deleteBridge: slug }),
        ...fetchNoStore,
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
      setMessage(`已删除桥接目录。当前桥接：${j.botName ?? '—'}，配置：${j.configPath ?? ''}。`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingBridge(false);
    }
  };

  const bridgeActionsLocked =
    !statusReady || saving || newBridging || deletingBridge;

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
            <a href="/projects">项目管理</a>
            <a href="/board">任务看板</a>
            <a href="/health">健康检查</a>
            <a href="/monitor">Auto Monitor</a>
          </nav>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.35rem' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="ui-btn secondary"
              disabled={saving || newBridging || deletingBridge}
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
            每个桥接目录相互独立，可同时运行；请在下方各行查看该目录的独立进程状态并启动或停止。
          </p>
          {!canSwitchBridges ? (
            <p className="ui-muted ui-small" style={{ margin: '0.4rem 0 0' }}>
              已设置 <code>CTI_HOME</code> 时由环境固定单一数据目录，无法在此新建多个桥接目录。
            </p>
          ) : null}
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
              const showAccordionChevron = canSwitchBridges && displayBridgeList.length > 1;
              const bridgePanelOpen = showAccordionChevron ? isBridgePanelExpanded(b) : true;
              const cfgB = bridgeConfigs[b] ?? defaultConfig();
              const updateBridgeConfig = (patch: Partial<Config>) => {
                setBridgeConfigs((prev) => {
                  const cur = prev[b] ?? defaultConfig();
                  return { ...prev, [b]: { ...cur, ...patch } };
                });
              };
              const updateImBot = (patch: Partial<ImInstanceSpec>) => {
                setBridgeConfigs((prev) => {
                  const cur = prev[b] ?? defaultConfig();
                  if (!cur.imBot) return prev;
                  return { ...prev, [b]: { ...cur, imBot: { ...cur.imBot, ...patch } } };
                });
              };
              const addImBot = () => {
                setBridgeConfigs((prev) => {
                  const cur = prev[b] ?? defaultConfig();
                  const template = normalizeRunners(asConfig(cur)).map((r) => ({ ...r }));
                  if (!template.length) {
                    template.push({ id: 'default', runtime: cur.runtime, label: '默认' });
                  }
                  const spec: ImInstanceSpec = {
                    id: b.trim() || 'im',
                    channel: 'telegram',
                    runners: template,
                    defaultRunnerId: template[0]?.id,
                  };
                  return { ...prev, [b]: { ...cur, imBot: spec } };
                });
              };
              const updateImRunner = (runnerIdx: number, patch: Partial<RunnerConfig>) => {
                setBridgeConfigs((prev) => {
                  const cur = prev[b] ?? defaultConfig();
                  const spec = cur.imBot;
                  if (!spec) return prev;
                  const runners = [...(spec.runners ?? normalizeRunners(asConfig(cur)))];
                  runners[runnerIdx] = { ...runners[runnerIdx], ...patch } as RunnerConfig;
                  return { ...prev, [b]: { ...cur, imBot: { ...spec, runners } } };
                });
              };
              const addImRunner = () => {
                setBridgeConfigs((prev) => {
                  const cur = prev[b] ?? defaultConfig();
                  const spec = cur.imBot;
                  if (!spec) return prev;
                  const runners = [...(spec.runners ?? normalizeRunners(asConfig(cur)))];
                  const n = runners.length + 1;
                  runners.push({ id: `rt-${n}`, runtime: 'claude', label: `Runner ${n}` });
                  return { ...prev, [b]: { ...cur, imBot: { ...spec, runners } } };
                });
              };
              const removeImRunner = (runnerIdx: number) => {
                setBridgeConfigs((prev) => {
                  const cur = prev[b] ?? defaultConfig();
                  const spec = cur.imBot;
                  if (!spec) return prev;
                  const runners = [...(spec.runners ?? [])].filter((_, i) => i !== runnerIdx);
                  return { ...prev, [b]: { ...cur, imBot: { ...spec, runners } } };
                });
              };
              const configDirtyB = !baselineBridgeConfigs?.[b]
                ? false
                : !adminConfigsEqual(cfgB, baselineBridgeConfigs[b]!);
              const embB = embeddedByBridge[b];
              const dmB = daemonStatusByBridge[b];
              const autoSummary = summarizeAutoMode(cfgB, b);
              const anyRunningB = embB?.running === true || dmB?.effectiveRunning === true;
              const startDisabledB = bridgeActionsLocked || configLoading || anyRunningB;
              const canStopB = anyRunningB;
              const stopDisabledB = bridgeActionsLocked || configLoading || !canStopB;
              const isKanbanBridgeRow = b === KANBAN_BRIDGE_SLUG;
              return (
              <div
                key={b}
                className="ui-bridge-accordion-item"
                role="listitem"
              >
                {showAccordionChevron ? (
                  <div className="ui-bridge-accordion-head">
                    <button
                      type="button"
                      className="ui-bridge-accordion-chevron-btn"
                      aria-expanded={isBridgePanelExpanded(b)}
                      aria-controls={`admin-bridge-panel-${b}`}
                      disabled={newBridging || deletingBridge}
                      onClick={() => toggleBridgePanelExpanded(b)}
                      title={isBridgePanelExpanded(b) ? '收起本行' : '展开本行'}
                    >
                      <span className="ui-bridge-accordion-chevron" aria-hidden>
                        {isBridgePanelExpanded(b) ? '▼' : '▶'}
                      </span>
                    </button>
                    <div
                      className="ui-bridge-accordion-title"
                      id={`admin-bridge-head-${b}`}
                    >
                      <code>{b}</code>
                    </div>
                  </div>
                ) : (
                  <div
                    className="ui-bridge-accordion-trigger ui-bridge-accordion-trigger-static"
                    id={`admin-bridge-head-${b}`}
                  >
                    <span className="ui-bridge-accordion-chevron" aria-hidden>
                      ▼
                    </span>
                    <code>{b}</code>
                  </div>
                )}
                {bridgePanelOpen ? (
                  <div
                    className="ui-bridge-accordion-panel"
                    id={`admin-bridge-panel-${b}`}
                    role="region"
                    aria-labelledby={`admin-bridge-head-${b}`}
                  >
        <div
          className="ui-card"
          style={{
            padding: '0.9rem 1rem',
            marginBottom: '1rem',
            border: '1px solid var(--ui-border, #333)',
            background: 'rgba(148, 163, 184, 0.06)',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: '0.75rem 1rem',
            }}
          >
            <div>
              <div className="ui-muted ui-small">Auto 模式</div>
              <div>{autoSummary.modeLabel}</div>
            </div>
            <div>
              <div className="ui-muted ui-small">Redis 命名空间</div>
              <div><code>{autoSummary.namespace}</code></div>
            </div>
            <div>
              <div className="ui-muted ui-small">Slave Runner</div>
              <div>{autoSummary.slaveRunnerId ? <code>{autoSummary.slaveRunnerId}</code> : '—'}</div>
            </div>
            <div>
              <div className="ui-muted ui-small">消费拓扑</div>
              <div>{autoSummary.consumerLabel ?? '—'}</div>
            </div>
            <div>
              <div className="ui-muted ui-small">磁盘 daemon 状态</div>
              <div>{dmB?.effectiveRunning ? '运行中' : '未运行'}{dmB?.pid ? ` (PID: ${dmB.pid})` : ''}</div>
            </div>
            <div>
              <div className="ui-muted ui-small">Slave 进程状态</div>
              <div>{dmB?.slave?.effectiveRunning ? '运行中' : '未运行'}{dmB?.slave?.pid ? ` (PID: ${dmB.slave.pid})` : ''}</div>
            </div>
            <div>
              <div className="ui-muted ui-small">App 子进程状态</div>
              <div>{embB?.running ? '运行中' : '未运行'}</div>
            </div>
          </div>
          {autoSummary.enabled ? (
            <p className="ui-muted ui-small" style={{ margin: '0.75rem 0 0' }}>
              master 队列按当前聊天 <code>/runner</code> 分流；slave 固定使用上方摘要里的 Runner。
            </p>
          ) : null}
        </div>
        <div className="ui-section-title">
          <h3>IM 机器人（CTI_IM_BOT）</h3>
          {!cfgB.imBot ? (
            <button type="button" className="ui-btn secondary" onClick={addImBot}>
              添加机器人
            </button>
          ) : null}
        </div>
        <p className="ui-muted ui-small">
          会话绑定里的 channelType 形如 <code>telegram:你的-id</code>。未使用 <code>CTI_IM_BOT</code> 时仍可依赖顶格{' '}
          <code>CTI_TG_BOT_TOKEN</code> 等字段（可直接编辑 config.env）。
        </p>
        {!cfgB.imBot ? (
          <p className="ui-muted ui-small">尚未配置机器人：请点击「添加机器人」。</p>
        ) : (
          <div className="ui-stack">
            {(() => {
              const spec = cfgB.imBot!;
              return (
              <div key="im-bot" className="ui-card" style={{ padding: '1rem', border: '1px solid var(--ui-border, #333)' }}>
                <div className="ui-grid" style={{ alignItems: 'flex-end' }}>
                  <div className="ui-field">
                    <span>桥接实例标识（路由与存储）</span>
                    <p className="ui-muted ui-small" style={{ margin: '0.35rem 0 0' }}>
                      与本行目录名一致，保存时由服务端写入 <code>CTI_IM_BOT.id</code>：
                      <code>{b}</code>
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
                  <label className="ui-field">
                    <span>Auto Master 回复超时（毫秒，留空=不限制，CTI_AUTO_MASTER_REPLY_TIMEOUT_MS）</span>
                    <input
                      type="number"
                      min={1}
                      value={cfgB.autoMasterReplyTimeoutMs ?? ''}
                      onChange={(e) =>
                        updateBridgeConfig({
                          autoMasterReplyTimeoutMs: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      placeholder="例如 120000"
                    />
                  </label>
                  <label className="ui-field">
                    <span>Auto Slave 回复超时（毫秒，留空=不限制，CTI_AUTO_SLAVE_REPLY_TIMEOUT_MS）</span>
                    <input
                      type="number"
                      min={1}
                      value={cfgB.autoSlaveReplyTimeoutMs ?? ''}
                      onChange={(e) =>
                        updateBridgeConfig({
                          autoSlaveReplyTimeoutMs: e.target.value
                            ? Number(e.target.value)
                            : undefined,
                        })
                      }
                      placeholder="例如 120000"
                    />
                  </label>
                  <label className="ui-field ui-check">
                    <input
                      type="checkbox"
                      checked={cfgB.autoLogStreamChunks !== false}
                      onChange={(e) =>
                        updateBridgeConfig({ autoLogStreamChunks: e.target.checked })
                      }
                    />
                    <span>Auto 模式记录 SSE 分片日志（关则 CTI_AUTO_LOG_STREAM_CHUNKS=0）</span>
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
                      {(spec.runners ?? normalizeRunners(asConfig(cfgB))).map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.id}（{r.runtime}）
                        </option>
                      ))}
                    </select>
                  </label>
                  {(spec.runners ?? normalizeRunners(asConfig(cfgB))).map((prof, ridx) => (
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
                        <>
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
                            <label className="ui-field ui-check">
                              <input
                                type="checkbox"
                                checked={prof.claudeUseLogin === true}
                                onChange={(e) =>
                                  updateImRunner(ridx, { claudeUseLogin: e.target.checked ? true : undefined })
                                }
                              />
                              <span>Claude 使用 CLI login</span>
                            </label>
                          </div>
                          <RunnerEnvTip runner={prof} envPresence={envPresence} />
                        </>
                      )}
                      {prof.runtime === 'codex' && (
                        <>
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
                          <RunnerEnvTip runner={prof} envPresence={envPresence} />
                        </>
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
                      {prof.runtime === 'copilot' && (
                        <div
                          className="ui-grid"
                          style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }}
                        >
                          <label className="ui-field">
                            <span>Copilot CLI 路径</span>
                            <input
                              value={prof.copilotExecutable ?? ''}
                              onChange={(e) =>
                                updateImRunner(ridx, { copilotExecutable: e.target.value || undefined })
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
                    <strong>Auto 模式（混合 Telegram + Redis）</strong>：同时填写 Telegram token 与 Redis URL 后，用户文本进入<strong>当前聊天所选 Runner</strong>（<code>/runner</code>）对应的 master <code>input</code>；桥从 Redis 取出后跑该 Runner 作为协调器，回复发到 Telegram 并写入 master <code>out</code>，随后下发给 slave（工具）。<strong>master 与 slave 同一条桥接进程</strong>；slave 若需独立 API Key 等，在下方「Slave Runner」配置后点击「保存 config.slave.env」。可选：<strong>另起桥接目录</strong>专跑 slave（两桥同一 Redis 命名空间 + 勾选「Slave 由独立桥接消费」）。前缀 <code>[master]</code> / <code>[slave]</code>。Telegram token 与 Redis URL 均<strong>必填</strong>。启用后关闭<strong>流式预览</strong>与<strong>运行时 token 级流式输出</strong>。
                  </p>
                  <div className="ui-grid">
                    <label className="ui-field ui-check">
                      <input
                        type="checkbox"
                        checked={!!spec.autoMode}
                        onChange={(e) => {
                          const on = e.target.checked ? true : false;
                          updateImBot({ autoMode: on });
                        }}
                      />
                      <span>启用 Auto 模式</span>
                    </label>
                  </div>
                  {spec.autoMode ? (
                    <div className="ui-grid">
                      <label className="ui-field">
                        <span>Redis URL（必填）</span>
                        <input
                          value={spec.autoRedisUrl ?? ''}
                          onChange={(e) =>
                            updateImBot({ autoRedisUrl: e.target.value || undefined })
                          }
                          placeholder="redis://127.0.0.1:6379"
                          required
                        />
                      </label>
                      <label className="ui-field">
                        <span>最大轮次</span>
                        <input
                          type="number"
                          min={1}
                          value={spec.autoMaxTurns ?? ''}
                          onChange={(e) =>
                            updateImBot({
                              autoMaxTurns: e.target.value ? Number(e.target.value) : undefined,
                            })
                          }
                        />
                      </label>
                      <label className="ui-field">
                        <span>Redis 命名空间（可选，双桥共用）</span>
                        <input
                          value={spec.autoRedisNamespace ?? ''}
                          onChange={(e) => {
                            const v = e.target.value.trim();
                            updateImBot({ autoRedisNamespace: v || undefined });
                          }}
                          placeholder="留空则用本桥目录名；双桥对齐时请填相同值"
                        />
                      </label>
                      {spec.channel !== 'telegram' && (
                        <p className="ui-muted ui-small" style={{ gridColumn: '1 / -1', margin: 0 }}>
                          Auto 模式仅支持 Telegram 混合模式；请先将平台切换为 Telegram 并填写 Bot Token。
                        </p>
                      )}
                      <div style={{ gridColumn: '1 / -1' }}>
                        <p className="ui-muted ui-small" style={{ marginBottom: '0.5rem' }}>
                          <strong>Slave 专用 Runner</strong>：字段与上方 Runners 相同；留空 Runner ID 则不使用专用配置，slave 与<strong>默认 Runner</strong>相同。Master 与 Slave 始终为独立桥接进程；配置完成后点击「保存 config.slave.env」将 Slave Runner 配置导出，另起桥接加载。
                        </p>
                        {(() => {
                          const slaveProf: RunnerConfig = spec.autoSlaveRunner ?? {
                            id: '',
                            runtime: 'claude',
                          };
                          const updateSlave = (patch: Partial<RunnerConfig>) => {
                            const merged: RunnerConfig = { ...slaveProf, ...patch };
                            const id = merged.id?.trim();
                            if (!id) {
                              updateImBot({ autoSlaveRunner: undefined });
                              return;
                            }
                            updateImBot({
                              autoSlaveRunner: {
                                ...merged,
                                id,
                                runtime: merged.runtime ?? 'claude',
                              },
                            });
                          };
                          return (
                            <div className="ui-slot" style={{ marginTop: '0.25rem' }}>
                              <div className="ui-slot-head">
                                <strong>Slave Runner</strong>
                                {spec.autoSlaveRunner?.id?.trim() ? (
                                  <button
                                    type="button"
                                    className="ui-btn ghost"
                                    onClick={() => updateImBot({ autoSlaveRunner: undefined })}
                                  >
                                    清除
                                  </button>
                                ) : null}
                              </div>
                              <div className="ui-grid">
                                <label className="ui-field">
                                  <span>Runner ID</span>
                                  <input
                                    value={slaveProf.id}
                                    onChange={(e) => updateSlave({ id: e.target.value })}
                                    placeholder="填写后启用专用 slave"
                                  />
                                </label>
                                <label className="ui-field">
                                  <span>显示名称</span>
                                  <input
                                    value={slaveProf.label ?? ''}
                                    onChange={(e) => updateSlave({ label: e.target.value || undefined })}
                                  />
                                </label>
                                <label className="ui-field">
                                  <span>后端类型</span>
                                  <select
                                    value={slaveProf.runtime}
                                    onChange={(e) =>
                                      updateSlave({ runtime: e.target.value as RunnerConfig['runtime'] })
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
                                    value={slaveProf.defaultModel ?? ''}
                                    onChange={(e) =>
                                      updateSlave({ defaultModel: e.target.value || undefined })
                                    }
                                  />
                                </label>
                                <label className="ui-field">
                                  <span>建议模式</span>
                                  <select
                                    value={slaveProf.defaultMode ?? ''}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      updateSlave({
                                        defaultMode:
                                          v === 'code' || v === 'plan' || v === 'ask' ? v : undefined,
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
                                    value={slaveProf.autoApprove === undefined ? '' : slaveProf.autoApprove ? 'yes' : 'no'}
                                    onChange={(e) => {
                                      const v = e.target.value;
                                      updateSlave({
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
                              {slaveProf.runtime === 'claude' && (
                                <>
                                  <div
                                    className="ui-grid"
                                    style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }}
                                  >
                                    <label className="ui-field">
                                      <span>Claude CLI 路径</span>
                                      <input
                                        value={slaveProf.claudeExecutable ?? ''}
                                        onChange={(e) =>
                                          updateSlave({ claudeExecutable: e.target.value || undefined })
                                        }
                                      />
                                    </label>
                                    <label className="ui-field ui-check">
                                      <input
                                        type="checkbox"
                                        checked={slaveProf.claudeUseLogin === true}
                                        onChange={(e) =>
                                          updateSlave({ claudeUseLogin: e.target.checked ? true : undefined })
                                        }
                                      />
                                      <span>Claude 使用 CLI login</span>
                                    </label>
                                  </div>
                                  <RunnerEnvTip runner={slaveProf} envPresence={envPresence} />
                                </>
                              )}
                              {slaveProf.runtime === 'codex' && (
                                <>
                                  <div
                                    className="ui-grid"
                                    style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }}
                                  >
                                    <label className="ui-field">
                                      <span>Codex wrapper 路径</span>
                                      <input
                                        value={slaveProf.codexExecutable ?? ''}
                                        onChange={(e) =>
                                          updateSlave({ codexExecutable: e.target.value || undefined })
                                        }
                                      />
                                    </label>
                                    <label className="ui-field ui-check">
                                      <input
                                        type="checkbox"
                                        checked={slaveProf.codexUseLogin === true}
                                        onChange={(e) =>
                                          updateSlave({ codexUseLogin: e.target.checked ? true : undefined })
                                        }
                                      />
                                      <span>Codex 使用 CLI login</span>
                                    </label>
                                  </div>
                                  <RunnerEnvTip runner={slaveProf} envPresence={envPresence} />
                                </>
                              )}
                              {slaveProf.runtime === 'cursor' && (
                                <div
                                  className="ui-grid"
                                  style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }}
                                >
                                  <label className="ui-field">
                                    <span>Cursor agent 路径</span>
                                    <input
                                      value={slaveProf.cursorExecutable ?? ''}
                                      onChange={(e) =>
                                        updateSlave({ cursorExecutable: e.target.value || undefined })
                                      }
                                    />
                                  </label>
                                </div>
                              )}
                              {slaveProf.runtime === 'copilot' && (
                                <div
                                  className="ui-grid"
                                  style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }}
                                >
                                  <label className="ui-field">
                                    <span>Copilot CLI 路径</span>
                                    <input
                                      value={slaveProf.copilotExecutable ?? ''}
                                      onChange={(e) =>
                                        updateSlave({ copilotExecutable: e.target.value || undefined })
                                      }
                                    />
                                  </label>
                                </div>
                              )}
                              {spec.channel === 'telegram' && spec.tgBotToken?.trim() && spec.autoRedisUrl?.trim() && (
                                <div style={{ marginTop: '0.75rem' }}>
                                  <button
                                    type="button"
                                    className="ui-btn ui-btn-sm"
                                    disabled={saving || !slaveProf.id?.trim()}
                                    onClick={() => void saveSlaveEnvForBridge(b)}
                                  >
                                    {saving ? '保存中…' : '保存 config.slave.env'}
                                  </button>
                                  <span className="ui-muted ui-small" style={{ marginLeft: '0.75rem' }}>
                                    将上方 Slave Runner 配置导出为 <code>config.slave.env</code>，供独立 slave 桥接加载。
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            );})()}
          </div>
        )}
        <p className="ui-muted ui-small" style={{ marginTop: '1rem' }}>
          写入配置中的 CTI_RUNTIME（本目录）：<code>{cfgB.runtime}</code>
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
          {isKanbanBridgeRow ? (
            <p className="ui-muted ui-small" style={{ margin: 0, flex: '1 1 200px' }}>
              Kanban 平台目录：仅可保存 <code>config.env</code>；启动与停止由平台进程管理，不在此操作。
            </p>
          ) : !canSwitchBridges ? (
            <p className="ui-muted ui-small" style={{ margin: 0, flex: '1 1 200px' }}>
              已设置 <code>CTI_HOME</code> 时由环境固定目录，无法在此新建多个桥接目录。
            </p>
          ) : (
            <p className="ui-muted ui-small" style={{ margin: 0, flex: '1 1 200px' }}>
              左侧箭头只展开/收起本行表单；各行可独立保存、启动或停止。
            </p>
          )}
          <button
            type="button"
            className="ui-btn primary"
            disabled={
              !configDirtyB ||
              configLoading ||
              saving ||
              newBridging ||
              deletingBridge
            }
            onClick={() => void saveBridgeConfig(b)}
            title={!configDirtyB ? '没有变更' : undefined}
          >
            {saving ? '保存中…' : '保存 config.env'}
          </button>
          {!isKanbanBridgeRow ? (
            <>
              <button type="button" className="ui-btn secondary" disabled={startDisabledB} onClick={() => void bridgeAction('start', b)}>
                启动桥接
              </button>
              <button type="button" className="ui-btn secondary" disabled={stopDisabledB} onClick={() => void bridgeAction('stop', b)}>
                停止桥接
              </button>
              {canSwitchBridges ? (
                <button
                  type="button"
                  className="ui-btn secondary"
                  disabled={saving || newBridging || deletingBridge}
                  onClick={() => void removeBridgeDirectory(b)}
                >
                  {deletingBridge ? '正在删除…' : '删除桥接'}
                </button>
              ) : null}
            </>
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
