'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  AgentEnvSlot,
  Config,
  ImInstanceChannel,
  ImInstanceSpec,
  RuntimeProfile,
} from '../../config';
import type { AgentInstanceRecord, AgentRole, TaskSession } from '../../platform/types';

const CHANNEL_OPTIONS = ['telegram', 'discord', 'feishu', 'qq', 'agent'] as const;
const IM_INSTANCE_CHANNELS: ImInstanceChannel[] = ['telegram', 'discord', 'feishu', 'qq'];
const RUNTIMES = ['claude', 'codex', 'cursor', 'auto'] as const;
const ROLES: AgentRole[] = ['developer', 'reviewer', 'tester'];

function defaultConfig(): Config {
  return {
    runtime: 'claude',
    enabledChannels: [],
    defaultWorkDir: '',
    defaultMode: 'code',
    autoApprove: false,
  };
}

export default function AdminPage() {
  const [cfg, setCfg] = useState<Config>(defaultConfig);
  const [configPath, setConfigPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskSession[]>([]);
  const [instances, setInstances] = useState<AgentInstanceRecord[]>([]);
  const [newInstance, setNewInstance] = useState({
    taskSessionId: '',
    role: 'developer' as AgentRole,
    runtimeProfileId: '' as string,
  });

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    try {
      const [cRes, tRes, iRes] = await Promise.all([
        fetch('/api/local-config'),
        fetch('/api/tasks'),
        fetch('/api/instances'),
      ]);
      const cJson = (await cRes.json()) as { config?: Config; configPath?: string };
      if (cJson.config) {
        const merged = { ...defaultConfig(), ...cJson.config };
        if (!merged.runtimeProfiles?.length) {
          merged.runtimeProfiles = [{ id: 'default', runtime: merged.runtime, label: 'Default' }];
        }
        setCfg(merged);
      }
      if (cJson.configPath) setConfigPath(cJson.configPath);
      if (tRes.ok) {
        const tJson = (await tRes.json()) as TaskSession[];
        setTasks(Array.isArray(tJson) ? tJson : []);
      }
      if (iRes.ok) {
        const iJson = (await iRes.json()) as AgentInstanceRecord[];
        setInstances(Array.isArray(iJson) ? iJson : []);
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasImFor = (ch: ImInstanceChannel) =>
    (cfg.imInstances ?? []).some((s) => s.channel === ch);

  const updateImInstance = (index: number, patch: Partial<ImInstanceSpec>) => {
    setCfg((prev) => {
      const list = [...(prev.imInstances ?? [])];
      list[index] = { ...list[index], ...patch } as ImInstanceSpec;
      return { ...prev, imInstances: list };
    });
  };

  const addImInstance = () => {
    setCfg((prev) => {
      const n = (prev.imInstances?.length ?? 0) + 1;
      const spec: ImInstanceSpec = {
        id: `im${n}`,
        channel: 'telegram',
        enabled: true,
      };
      return { ...prev, imInstances: [...(prev.imInstances ?? []), spec] };
    });
  };

  const removeImInstance = (index: number) => {
    setCfg((prev) => ({
      ...prev,
      imInstances: (prev.imInstances ?? []).filter((_, i) => i !== index),
    }));
  };

  const toggleChannel = (ch: (typeof CHANNEL_OPTIONS)[number]) => {
    setCfg((prev) => {
      const set = new Set(prev.enabledChannels);
      if (set.has(ch)) set.delete(ch);
      else set.add(ch);
      return { ...prev, enabledChannels: Array.from(set) };
    });
  };

  const updateSlot = (index: number, patch: Partial<AgentEnvSlot>) => {
    setCfg((prev) => {
      const slots = [...(prev.agentEnvSlots ?? [])];
      slots[index] = { ...slots[index], ...patch, slot: slots[index]?.slot ?? index + 1 };
      return { ...prev, agentEnvSlots: slots };
    });
  };

  const addAgentSlot = () => {
    setCfg((prev) => {
      const slots = [...(prev.agentEnvSlots ?? [])];
      const used = new Set(slots.map((s) => s.slot));
      let nextSlot = 1;
      while (used.has(nextSlot) && nextSlot <= 10) nextSlot += 1;
      if (nextSlot > 10) return prev;
      slots.push({
        slot: nextSlot,
        redisUrl: 'redis://127.0.0.1:6379',
        firstPrompt: 'Hello, how are you?',
        openaiBaseUrl: 'https://api.openai.com/v1',
        openaiModel: 'gpt-4o-mini',
        maxTurns: 10,
      });
      return { ...prev, agentEnvSlots: slots };
    });
  };

  const removeAgentSlot = (index: number) => {
    setCfg((prev) => ({
      ...prev,
      agentEnvSlots: (prev.agentEnvSlots ?? []).filter((_, i) => i !== index),
    }));
  };

  const updateRuntimeProfile = (index: number, patch: Partial<RuntimeProfile>) => {
    setCfg((prev) => {
      const list = [...(prev.runtimeProfiles ?? [])];
      list[index] = { ...list[index], ...patch } as RuntimeProfile;
      return { ...prev, runtimeProfiles: list };
    });
  };

  const addRuntimeProfile = () => {
    setCfg((prev) => {
      const list = [...(prev.runtimeProfiles ?? [])];
      const n = list.length + 1;
      list.push({ id: `rt-${n}`, runtime: 'claude', label: `Profile ${n}` });
      return { ...prev, runtimeProfiles: list };
    });
  };

  const removeRuntimeProfile = (index: number) => {
    setCfg((prev) => ({
      ...prev,
      runtimeProfiles: (prev.runtimeProfiles ?? []).filter((_, i) => i !== index),
    }));
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
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(j.error || res.statusText);
      setMessage('Saved to ~/.claude-to-im/config.env. Restart the bridge or Next server if needed.');
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const createInstance = async () => {
    if (!newInstance.taskSessionId) return;
    setMessage(null);
    try {
      const res = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskSessionId: newInstance.taskSessionId,
          role: newInstance.role,
          ...(newInstance.runtimeProfileId ? { runtimeProfileId: newInstance.runtimeProfileId } : {}),
        }),
      });
      const j = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(j.error || res.statusText);
      await load();
      setMessage('Instance created and start requested.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const bridgeAction = async (action: 'start' | 'stop') => {
    setMessage(null);
    try {
      const res = await fetch(`/api/bridge/${action}`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      setMessage(`Bridge ${action} OK.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const instanceAction = async (id: string, action: 'start' | 'stop' | 'delete') => {
    setMessage(null);
    try {
      const url =
        action === 'delete'
          ? `/api/instances/${encodeURIComponent(id)}`
          : `/api/instances/${encodeURIComponent(id)}/${action}`;
      const res = await fetch(url, { method: action === 'delete' ? 'DELETE' : 'POST' });
      if (!res.ok) throw new Error(await res.text());
      await load();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const taskOptions = useMemo(
    () =>
      tasks.map((t) => ({
        id: t.id,
        label: `${t.issueId} — ${t.title}`,
      })),
    [tasks],
  );

  if (loading) {
    return (
      <main className="page-shell ui-admin">
        <p className="ui-muted">Loading…</p>
      </main>
    );
  }

  return (
    <main className="page-shell ui-admin">
      <header className="ui-admin-header">
        <p className="eyebrow">Local admin</p>
        <h1>Bridge &amp; platform</h1>
        <p className="lead ui-muted">
          Edit <code>{configPath || '~/.claude-to-im/config.env'}</code>, enable IM channels, add numbered Agent
          instances, and manage platform agent runners. Secrets you do not change stay as-is (masked on load).
        </p>
        <nav className="ui-nav">
          <a href="/">Home</a>
          <a href="/board">Jira-style board</a>
          <a href="/health">Health</a>
        </nav>
      </header>

      {message ? <p className="ui-banner">{message}</p> : null}

      <section className="ui-section hero-card">
        <div className="ui-section-title">
          <h2>Runtime profiles (多 Runtime)</h2>
          <button type="button" className="ui-btn secondary" onClick={addRuntimeProfile}>
            Add profile
          </button>
        </div>
        <p className="ui-muted ui-small">
          Each profile is one backend (claude / codex / cursor / auto). The IM bridge uses the
          default profile below; platform tasks can reference a profile id or fall back to the task&apos;s
          stored runtime.
        </p>
        {(cfg.runtimeProfiles ?? []).map((prof, index) => (
          <div key={`${prof.id}-${index}`} className="ui-slot">
            <div className="ui-slot-head">
              <strong>Profile</strong>
              <button type="button" className="ui-btn ghost" onClick={() => removeRuntimeProfile(index)}>
                Remove
              </button>
            </div>
            <div className="ui-grid">
              <label className="ui-field">
                <span>Id (unique)</span>
                <input
                  value={prof.id}
                  onChange={(e) => updateRuntimeProfile(index, { id: e.target.value })}
                />
              </label>
              <label className="ui-field">
                <span>Label</span>
                <input
                  value={prof.label ?? ''}
                  onChange={(e) => updateRuntimeProfile(index, { label: e.target.value || undefined })}
                />
              </label>
              <label className="ui-field">
                <span>Runtime</span>
                <select
                  value={prof.runtime}
                  onChange={(e) => updateRuntimeProfile(index, { runtime: e.target.value as RuntimeProfile['runtime'] })}
                >
                  {RUNTIMES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ))}
        <label className="ui-field">
          <span>Default profile for IM bridge (CTI_DEFAULT_RUNTIME_PROFILE)</span>
          <select
            value={cfg.defaultRuntimeProfileId ?? (cfg.runtimeProfiles?.[0]?.id ?? '')}
            onChange={(e) => setCfg({ ...cfg, defaultRuntimeProfileId: e.target.value || undefined })}
          >
            {(cfg.runtimeProfiles ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} ({p.runtime})
              </option>
            ))}
          </select>
        </label>
        <p className="ui-muted ui-small">
          Effective bridge runtime (saved as CTI_RUNTIME): <code>{cfg.runtime}</code>
        </p>
      </section>

      <section className="ui-section hero-card">
        <h2>Defaults</h2>
        <div className="ui-grid">
          <label className="ui-field">
            <span>Default workdir</span>
            <input
              value={cfg.defaultWorkDir ?? ''}
              onChange={(e) => setCfg({ ...cfg, defaultWorkDir: e.target.value })}
            />
          </label>
          <label className="ui-field">
            <span>Default model (optional)</span>
            <input
              value={cfg.defaultModel ?? ''}
              onChange={(e) => setCfg({ ...cfg, defaultModel: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Default mode</span>
            <input
              value={cfg.defaultMode ?? 'code'}
              onChange={(e) => setCfg({ ...cfg, defaultMode: e.target.value })}
            />
          </label>
          <label className="ui-field">
            <span>Proxy (optional)</span>
            <input value={cfg.proxy ?? ''} onChange={(e) => setCfg({ ...cfg, proxy: e.target.value || undefined })} />
          </label>
          <label className="ui-field ui-check">
            <input
              type="checkbox"
              checked={!!cfg.autoApprove}
              onChange={(e) => setCfg({ ...cfg, autoApprove: e.target.checked })}
            />
            <span>CTI_AUTO_APPROVE</span>
          </label>
          <label className="ui-field">
            <span>Web base URL (approval links)</span>
            <input
              value={cfg.webBaseUrl ?? ''}
              onChange={(e) => setCfg({ ...cfg, webBaseUrl: e.target.value || undefined })}
              placeholder="http://127.0.0.1:3000"
            />
          </label>
        </div>
      </section>

      <section className="ui-section hero-card">
        <h2>Channels (CTI_ENABLED_CHANNELS)</h2>
        <div className="ui-channel-row">
          {CHANNEL_OPTIONS.map((ch) => (
            <label key={ch} className="ui-check">
              <input
                type="checkbox"
                checked={cfg.enabledChannels.includes(ch)}
                onChange={() => toggleChannel(ch)}
              />
              <span>{ch}</span>
            </label>
          ))}
        </div>
        <p className="ui-muted ui-small">
          Configure credentials per channel below. Restart the bridge after saving.
        </p>
      </section>

      <section className="ui-section hero-card">
        <div className="ui-section-title">
          <h2>IM multi-instance (CTI_IM_INSTANCES)</h2>
          <button type="button" className="ui-btn secondary" onClick={addImInstance}>
            Add bot instance
          </button>
        </div>
        <p className="ui-muted ui-small">
          Multiple bots in one bridge (same or mixed platforms). Each row is one bot;{' '}
          <code>channelType</code> in bindings becomes <code>telegram:your-id</code>. For any channel
          listed here, the single-channel form below for that platform is ignored.
        </p>
        {(cfg.imInstances ?? []).length === 0 ? (
          <p className="ui-muted ui-small">No extra instances — legacy single-token fields apply.</p>
        ) : (
          <div className="ui-stack">
            {(cfg.imInstances ?? []).map((spec, idx) => (
              <div key={idx} className="ui-card" style={{ padding: '1rem', border: '1px solid var(--ui-border, #333)' }}>
                <div className="ui-grid" style={{ alignItems: 'flex-end' }}>
                  <label className="ui-field">
                    <span>Instance id (slug)</span>
                    <input
                      value={spec.id}
                      onChange={(e) => updateImInstance(idx, { id: e.target.value.trim() })}
                      placeholder="work"
                    />
                  </label>
                  <label className="ui-field">
                    <span>Channel</span>
                    <select
                      value={spec.channel}
                      onChange={(e) =>
                        updateImInstance(idx, { channel: e.target.value as ImInstanceChannel })
                      }
                    >
                      {IM_INSTANCE_CHANNELS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ui-field ui-check">
                    <input
                      type="checkbox"
                      checked={spec.enabled !== false}
                      onChange={(e) => updateImInstance(idx, { enabled: e.target.checked })}
                    />
                    <span>Enabled</span>
                  </label>
                  <button
                    type="button"
                    className="ui-btn secondary"
                    onClick={() => removeImInstance(idx)}
                  >
                    Remove
                  </button>
                </div>
                {spec.channel === 'telegram' ? (
                  <div className="ui-grid">
                    <label className="ui-field">
                      <span>tgBotToken</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={spec.tgBotToken ?? ''}
                        onChange={(e) => updateImInstance(idx, { tgBotToken: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>tgChatId</span>
                      <input
                        value={spec.tgChatId ?? ''}
                        onChange={(e) => updateImInstance(idx, { tgChatId: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>tgAllowedUsers (comma)</span>
                      <input
                        value={spec.tgAllowedUsers?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImInstance(idx, {
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
                  <div className="ui-grid">
                    <label className="ui-field">
                      <span>discordBotToken</span>
                      <input
                        type="password"
                        value={spec.discordBotToken ?? ''}
                        onChange={(e) =>
                          updateImInstance(idx, { discordBotToken: e.target.value || undefined })
                        }
                      />
                    </label>
                    <label className="ui-field">
                      <span>Allowed users (comma)</span>
                      <input
                        value={spec.discordAllowedUsers?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImInstance(idx, {
                            discordAllowedUsers: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <label className="ui-field">
                      <span>Allowed channels (comma)</span>
                      <input
                        value={spec.discordAllowedChannels?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImInstance(idx, {
                            discordAllowedChannels: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                      />
                    </label>
                    <label className="ui-field">
                      <span>Allowed guilds (comma)</span>
                      <input
                        value={spec.discordAllowedGuilds?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImInstance(idx, {
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
                  <div className="ui-grid">
                    <label className="ui-field">
                      <span>feishuAppId</span>
                      <input
                        value={spec.feishuAppId ?? ''}
                        onChange={(e) => updateImInstance(idx, { feishuAppId: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>feishuAppSecret</span>
                      <input
                        type="password"
                        value={spec.feishuAppSecret ?? ''}
                        onChange={(e) =>
                          updateImInstance(idx, { feishuAppSecret: e.target.value || undefined })
                        }
                      />
                    </label>
                    <label className="ui-field">
                      <span>feishuDomain</span>
                      <input
                        value={spec.feishuDomain ?? ''}
                        onChange={(e) => updateImInstance(idx, { feishuDomain: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>Allowed users (comma)</span>
                      <input
                        value={spec.feishuAllowedUsers?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImInstance(idx, {
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
                  <div className="ui-grid">
                    <label className="ui-field">
                      <span>qqAppId</span>
                      <input
                        value={spec.qqAppId ?? ''}
                        onChange={(e) => updateImInstance(idx, { qqAppId: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>qqAppSecret</span>
                      <input
                        type="password"
                        value={spec.qqAppSecret ?? ''}
                        onChange={(e) => updateImInstance(idx, { qqAppSecret: e.target.value || undefined })}
                      />
                    </label>
                    <label className="ui-field">
                      <span>Allowed users (comma)</span>
                      <input
                        value={spec.qqAllowedUsers?.join(',') ?? ''}
                        onChange={(e) =>
                          updateImInstance(idx, {
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
                        onChange={(e) => updateImInstance(idx, { qqImageEnabled: e.target.checked })}
                      />
                      <span>qqImageEnabled</span>
                    </label>
                    <label className="ui-field">
                      <span>qqMaxImageSize</span>
                      <input
                        type="number"
                        value={spec.qqMaxImageSize ?? ''}
                        onChange={(e) =>
                          updateImInstance(idx, {
                            qqMaxImageSize: e.target.value ? Number(e.target.value) : undefined,
                          })
                        }
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {!hasImFor('telegram') ? (
      <section className="ui-section hero-card">
        <h2>Telegram</h2>
        <div className="ui-grid">
          <label className="ui-field">
            <span>Bot token</span>
            <input
              type="password"
              autoComplete="off"
              value={cfg.tgBotToken ?? ''}
              onChange={(e) => setCfg({ ...cfg, tgBotToken: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Chat ID</span>
            <input value={cfg.tgChatId ?? ''} onChange={(e) => setCfg({ ...cfg, tgChatId: e.target.value || undefined })} />
          </label>
          <label className="ui-field">
            <span>Allowed users (comma-separated)</span>
            <input
              value={cfg.tgAllowedUsers?.join(',') ?? ''}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  tgAllowedUsers: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </div>
      </section>
      ) : (
      <section className="ui-section hero-card">
        <h2>Telegram</h2>
        <p className="ui-muted ui-small">Credentials are configured under IM multi-instance.</p>
      </section>
      )}

      {!hasImFor('discord') ? (
      <section className="ui-section hero-card">
        <h2>Discord</h2>
        <div className="ui-grid">
          <label className="ui-field">
            <span>Bot token</span>
            <input
              type="password"
              value={cfg.discordBotToken ?? ''}
              onChange={(e) => setCfg({ ...cfg, discordBotToken: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Allowed users</span>
            <input
              value={cfg.discordAllowedUsers?.join(',') ?? ''}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  discordAllowedUsers: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label className="ui-field">
            <span>Allowed channels</span>
            <input
              value={cfg.discordAllowedChannels?.join(',') ?? ''}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  discordAllowedChannels: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
          <label className="ui-field">
            <span>Allowed guilds</span>
            <input
              value={cfg.discordAllowedGuilds?.join(',') ?? ''}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  discordAllowedGuilds: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </div>
      </section>
      ) : (
      <section className="ui-section hero-card">
        <h2>Discord</h2>
        <p className="ui-muted ui-small">Credentials are configured under IM multi-instance.</p>
      </section>
      )}

      {!hasImFor('feishu') ? (
      <section className="ui-section hero-card">
        <h2>Feishu / Lark</h2>
        <div className="ui-grid">
          <label className="ui-field">
            <span>App ID</span>
            <input value={cfg.feishuAppId ?? ''} onChange={(e) => setCfg({ ...cfg, feishuAppId: e.target.value || undefined })} />
          </label>
          <label className="ui-field">
            <span>App secret</span>
            <input
              type="password"
              value={cfg.feishuAppSecret ?? ''}
              onChange={(e) => setCfg({ ...cfg, feishuAppSecret: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Domain</span>
            <input
              value={cfg.feishuDomain ?? ''}
              onChange={(e) => setCfg({ ...cfg, feishuDomain: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Allowed users</span>
            <input
              value={cfg.feishuAllowedUsers?.join(',') ?? ''}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  feishuAllowedUsers: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </div>
      </section>
      ) : (
      <section className="ui-section hero-card">
        <h2>Feishu / Lark</h2>
        <p className="ui-muted ui-small">Credentials are configured under IM multi-instance.</p>
      </section>
      )}

      {!hasImFor('qq') ? (
      <section className="ui-section hero-card">
        <h2>QQ</h2>
        <div className="ui-grid">
          <label className="ui-field">
            <span>App ID</span>
            <input value={cfg.qqAppId ?? ''} onChange={(e) => setCfg({ ...cfg, qqAppId: e.target.value || undefined })} />
          </label>
          <label className="ui-field">
            <span>App secret</span>
            <input
              type="password"
              value={cfg.qqAppSecret ?? ''}
              onChange={(e) => setCfg({ ...cfg, qqAppSecret: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Allowed users</span>
            <input
              value={cfg.qqAllowedUsers?.join(',') ?? ''}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  qqAllowedUsers: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
          </label>
        </div>
      </section>
      ) : (
      <section className="ui-section hero-card">
        <h2>QQ</h2>
        <p className="ui-muted ui-small">Credentials are configured under IM multi-instance.</p>
      </section>
      )}

      <section className="ui-section hero-card">
        <h2>Agent channel (single instance)</h2>
        <div className="ui-grid">
          <label className="ui-field">
            <span>Redis URL</span>
            <input
              value={cfg.agentRedisUrl ?? ''}
              onChange={(e) => setCfg({ ...cfg, agentRedisUrl: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>OpenAI API key</span>
            <input
              type="password"
              value={cfg.agentOpenAIApiKey ?? ''}
              onChange={(e) => setCfg({ ...cfg, agentOpenAIApiKey: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Base URL</span>
            <input
              value={cfg.agentOpenAIBaseUrl ?? ''}
              onChange={(e) => setCfg({ ...cfg, agentOpenAIBaseUrl: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Model</span>
            <input
              value={cfg.agentOpenAIModel ?? ''}
              onChange={(e) => setCfg({ ...cfg, agentOpenAIModel: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>First prompt</span>
            <input
              value={cfg.agentFirstPrompt ?? ''}
              onChange={(e) => setCfg({ ...cfg, agentFirstPrompt: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Max turns</span>
            <input
              type="number"
              value={cfg.agentMaxTurns ?? ''}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  agentMaxTurns: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </label>
        </div>
      </section>

      <section className="ui-section hero-card">
        <div className="ui-section-title">
          <h2>Agent multi-instance (CTI_AGENT_1_*, …)</h2>
          <button type="button" className="ui-btn secondary" onClick={addAgentSlot}>
            Add slot
          </button>
        </div>
        {(cfg.agentEnvSlots ?? []).map((slot, index) => (
          <div key={`${slot.slot}-${index}`} className="ui-slot">
            <div className="ui-slot-head">
              <strong>Slot {slot.slot}</strong>
              <button type="button" className="ui-btn ghost" onClick={() => removeAgentSlot(index)}>
                Remove
              </button>
            </div>
            <div className="ui-grid">
              <label className="ui-field">
                <span>Slot number (1–10)</span>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={slot.slot}
                  onChange={(e) => updateSlot(index, { slot: Number(e.target.value) })}
                />
              </label>
              <label className="ui-field">
                <span>OpenAI API key</span>
                <input
                  type="password"
                  value={slot.openaiApiKey ?? ''}
                  onChange={(e) => updateSlot(index, { openaiApiKey: e.target.value || undefined })}
                />
              </label>
              <label className="ui-field">
                <span>Redis URL</span>
                <input
                  value={slot.redisUrl ?? ''}
                  onChange={(e) => updateSlot(index, { redisUrl: e.target.value || undefined })}
                />
              </label>
              <label className="ui-field">
                <span>Model</span>
                <input
                  value={slot.openaiModel ?? ''}
                  onChange={(e) => updateSlot(index, { openaiModel: e.target.value || undefined })}
                />
              </label>
            </div>
          </div>
        ))}
      </section>

      <section className="ui-section hero-card">
        <h2>Jira (platform agents)</h2>
        <div className="ui-grid">
          <label className="ui-field">
            <span>Base URL</span>
            <input
              value={cfg.jiraBaseUrl ?? ''}
              onChange={(e) => setCfg({ ...cfg, jiraBaseUrl: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Email</span>
            <input value={cfg.jiraEmail ?? ''} onChange={(e) => setCfg({ ...cfg, jiraEmail: e.target.value || undefined })} />
          </label>
          <label className="ui-field">
            <span>API token</span>
            <input
              type="password"
              value={cfg.jiraApiToken ?? ''}
              onChange={(e) => setCfg({ ...cfg, jiraApiToken: e.target.value || undefined })}
            />
          </label>
          <label className="ui-field">
            <span>Poll interval (ms)</span>
            <input
              type="number"
              value={cfg.jiraPollIntervalMs ?? ''}
              onChange={(e) =>
                setCfg({
                  ...cfg,
                  jiraPollIntervalMs: e.target.value ? Number(e.target.value) : undefined,
                })
              }
            />
          </label>
          <label className="ui-field">
            <span>Bot account ID (optional)</span>
            <input
              value={cfg.jiraBotAccountId ?? ''}
              onChange={(e) => setCfg({ ...cfg, jiraBotAccountId: e.target.value || undefined })}
            />
          </label>
        </div>
      </section>

      <section className="ui-section hero-card ui-actions-bar">
        <button type="button" className="ui-btn primary" disabled={saving} onClick={() => void saveConfig()}>
          {saving ? 'Saving…' : 'Save config.env'}
        </button>
        <button type="button" className="ui-btn secondary" onClick={() => void bridgeAction('start')}>
          Bridge start
        </button>
        <button type="button" className="ui-btn secondary" onClick={() => void bridgeAction('stop')}>
          Bridge stop
        </button>
      </section>

      <section className="ui-section hero-card">
        <h2>Platform agent instances</h2>
        <p className="ui-muted ui-small">
          Creates a runner for an existing task session (same as workflow). Requires Jira env above.
        </p>
        <div className="ui-inline">
          <select
            value={newInstance.taskSessionId}
            onChange={(e) => setNewInstance({ ...newInstance, taskSessionId: e.target.value })}
          >
            <option value="">Select task session…</option>
            {taskOptions.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            value={newInstance.role}
            onChange={(e) => setNewInstance({ ...newInstance, role: e.target.value as AgentRole })}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            value={newInstance.runtimeProfileId}
            onChange={(e) => setNewInstance({ ...newInstance, runtimeProfileId: e.target.value })}
          >
            <option value="">Runtime profile (optional)</option>
            {(cfg.runtimeProfiles ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.id} → {p.runtime}
              </option>
            ))}
          </select>
          <button type="button" className="ui-btn primary" onClick={() => void createInstance()}>
            Create / restart instance
          </button>
        </div>

        <table className="ui-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Role</th>
              <th>Profile</th>
              <th>Status</th>
              <th>Task</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {instances.map((i) => (
              <tr key={i.id}>
                <td className="ui-mono">{i.id.slice(0, 8)}…</td>
                <td>{i.role}</td>
                <td className="ui-mono">{i.runtimeProfileId ?? '—'}</td>
                <td>{i.status}</td>
                <td className="ui-mono">{i.taskId}</td>
                <td className="ui-actions">
                  <button type="button" className="ui-btn ghost" onClick={() => void instanceAction(i.id, 'start')}>
                    Start
                  </button>
                  <button type="button" className="ui-btn ghost" onClick={() => void instanceAction(i.id, 'stop')}>
                    Stop
                  </button>
                  <button type="button" className="ui-btn danger" onClick={() => void instanceAction(i.id, 'delete')}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
