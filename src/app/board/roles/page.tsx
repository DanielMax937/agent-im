'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { KanbanAgentKind, KanbanRoleMember, Project } from '../../../platform/types';

type RunnerOption = { id: string; label: string; runtime: string };

type SkillCatalogOption = { id: string; label: string; source: string };

type KanbanRolesPayload = {
  projectId: string;
  kinds: KanbanAgentKind[];
  roleLabels: Record<KanbanAgentKind, string>;
  runners: RunnerOption[];
  mapping: Partial<Record<KanbanAgentKind, string>>;
  members?: Partial<Record<KanbanAgentKind, KanbanRoleMember[]>>;
  defaultLaneSkills?: Partial<Record<KanbanAgentKind, string[]>>;
  kanbanLaneSkills?: Partial<Record<KanbanAgentKind, string[]>>;
};

const EMPTY_MAPPING: Record<KanbanAgentKind, string> = {
  'agent-dev': '',
  'pre-tester': '',
  'codex-senior': '',
  'claude-review': '',
  'copilot-test': '',
  'self-host-runner': '',
};

function emptyMembers(): Record<KanbanAgentKind, KanbanRoleMember[]> {
  return {
    'agent-dev': [],
    'pre-tester': [],
    'codex-senior': [],
    'claude-review': [],
    'copilot-test': [],
    'self-host-runner': [],
  };
}

function emptyLaneSkills(): Record<KanbanAgentKind, string[]> {
  return {
    'agent-dev': [],
    'pre-tester': [],
    'codex-senior': [],
    'claude-review': [],
    'copilot-test': [],
    'self-host-runner': [],
  };
}

function LaneSkillPicker(props: {
  laneLabel: string;
  catalog: SkillCatalogOption[];
  selectedIds: string[];
  defaultLines: string[];
  onChange: (ids: string[]) => void;
}) {
  const { laneLabel, catalog, selectedIds, defaultLines, onChange } = props;
  const available = useMemo(
    () =>
      catalog
        .filter((s) => !selectedIds.includes(s.id))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [catalog, selectedIds],
  );
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <p className="ui-muted ui-small" style={{ marginBottom: '0.35rem' }}>
        <strong>{laneLabel}</strong>
        ：未选任何项时使用下方「代码内置默认」；选中后任务 prompt 会注入对应 skill 的展示名。
      </p>
      <div className="skill-tag-row" style={{ marginBottom: '0.35rem' }}>
        {selectedIds.map((id) => {
          const opt = catalog.find((o) => o.id === id);
          return (
            <span key={id} className="skill-tag">
              <span>{opt?.label ?? id}</span>
              {opt?.source ? (
                <span className="ui-mono" style={{ opacity: 0.75, fontSize: '11px' }}>
                  [{opt.source}]
                </span>
              ) : null}
              <button
                type="button"
                aria-label={`移除 ${id}`}
                onClick={() => onChange(selectedIds.filter((x) => x !== id))}
              >
                ×
              </button>
            </span>
          );
        })}
      </div>
      <label className="ui-small">
        添加 skill
        <select
          className="ui-input"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v) onChange([...selectedIds, v]);
            e.currentTarget.value = '';
          }}
        >
          <option value="">选择…</option>
          {available.map((s) => (
            <option key={s.id} value={s.id}>
              [{s.source}] {s.label} — {s.id}
            </option>
          ))}
        </select>
      </label>
      <details className="ui-small" style={{ marginTop: '0.5rem' }}>
        <summary className="ui-muted">本 lane 默认（代码内置）</summary>
        <ul className="ui-muted" style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
          {defaultLines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}

export default function BoardRolesPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [runners, setRunners] = useState<RunnerOption[]>([]);
  const [kinds, setKinds] = useState<KanbanAgentKind[]>([]);
  const [roleLabels, setRoleLabels] = useState<Record<string, string>>({});
  const [mapping, setMapping] = useState<Record<KanbanAgentKind, string>>({ ...EMPTY_MAPPING });
  const [members, setMembers] = useState<Record<KanbanAgentKind, KanbanRoleMember[]>>(emptyMembers);
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogOption[]>([]);
  const [defaultLaneSkills, setDefaultLaneSkills] = useState<Partial<Record<KanbanAgentKind, string[]>> | null>(
    null,
  );
  const [laneSkills, setLaneSkills] = useState<Record<KanbanAgentKind, string[]>>(emptyLaneSkills);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  /** Latest selected project — used to ignore stale kanban-roles responses after switching projects. */
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const loadProjects = useCallback(async () => {
    const res = await fetch('/api/projects', { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    const body = (await res.json()) as Project[];
    setProjects(Array.isArray(body) ? body : []);
  }, []);

  const loadSkillCatalog = useCallback(async () => {
    const res = await fetch('/api/skills/catalog', { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    const body = (await res.json()) as { skills?: SkillCatalogOption[] };
    setSkillCatalog(Array.isArray(body.skills) ? body.skills : []);
  }, []);

  const loadKanbanRoles = useCallback(async (pid: string) => {
    if (!pid) return;
    const res = await fetch(`/api/projects/${encodeURIComponent(pid)}/kanban-roles`, { cache: 'no-store' });
    if (!res.ok) throw new Error(await res.text());
    const data = (await res.json()) as KanbanRolesPayload;
    if (pid !== projectIdRef.current) {
      return;
    }
    setKinds(data.kinds?.length ? data.kinds : []);
    setRoleLabels(data.roleLabels ?? {});
    const next = { ...EMPTY_MAPPING };
    for (const k of data.kinds ?? []) {
      next[k] = data.mapping[k] ?? '';
    }
    setMapping(next);
    const nextM = emptyMembers();
    const raw = data.members ?? {};
    for (const k of data.kinds ?? []) {
      const list = raw[k];
      nextM[k] = Array.isArray(list) ? [...list] : [];
    }
    setMembers(nextM);
    setDefaultLaneSkills(data.defaultLaneSkills ?? null);
    const nextLs = emptyLaneSkills();
    const rawSkills = data.kanbanLaneSkills ?? {};
    for (const k of data.kinds ?? []) {
      const list = rawSkills[k];
      nextLs[k] = Array.isArray(list) ? [...list] : [];
    }
    setLaneSkills(nextLs);
    if (Array.isArray(data.runners)) {
      setRunners(data.runners);
    }
  }, []);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadProjects(), loadSkillCatalog()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [loadProjects, loadSkillCatalog]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void (async () => {
      try {
        await loadKanbanRoles(projectId);
        if (!cancelled) setSavedAt(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, loadKanbanRoles]);

  useEffect(() => {
    if (projects.length === 0 || projectId) return;
    setProjectId(projects[0].id);
  }, [projects, projectId]);

  const runnerHint = useMemo(() => {
    if (runners.length === 0) {
      return '当前未加载到任何 runner。请在 ~/.claude-to-im/…/config.env 中配置 CTI_RUNNERS（JSON 数组）或单 bot 的 runners，并重启 Next.js。';
    }
    return null;
  }, [runners.length]);

  function addMemberRow(kind: KanbanAgentKind) {
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `m-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setMembers((prev) => ({
      ...prev,
      [kind]: [...(prev[kind] ?? []), { id, name: '', runnerProfileId: runners[0]?.id ?? '' }],
    }));
  }

  function updateMember(kind: KanbanAgentKind, index: number, patch: Partial<KanbanRoleMember>) {
    setMembers((prev) => {
      const list = [...(prev[kind] ?? [])];
      const cur = list[index];
      if (!cur) return prev;
      list[index] = { ...cur, ...patch };
      return { ...prev, [kind]: list };
    });
  }

  function removeMember(kind: KanbanAgentKind, index: number) {
    setMembers((prev) => {
      const list = [...(prev[kind] ?? [])];
      list.splice(index, 1);
      return { ...prev, [kind]: list };
    });
  }

  async function save() {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      const kanbanRoleRunners: Record<string, string> = {};
      for (const k of kinds) {
        kanbanRoleRunners[k] = mapping[k]?.trim() ?? '';
      }
      const kanbanRoleMembers: Record<string, KanbanRoleMember[]> = {};
      for (const k of kinds) {
        kanbanRoleMembers[k] = (members[k] ?? [])
          .filter((m) => m.id.trim() && m.runnerProfileId.trim())
          .map((m) => ({
            id: m.id.trim(),
            name: (m.name || m.id).trim(),
            runnerProfileId: m.runnerProfileId.trim(),
          }));
      }
      const kanbanLaneSkills: Record<string, string[]> = {};
      for (const k of kinds) {
        kanbanLaneSkills[k] = (laneSkills[k] ?? []).filter(Boolean);
      }
      const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/kanban-roles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kanbanRoleRunners, kanbanRoleMembers, kanbanLaneSkills }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error || (await res.text()));
      setSavedAt(new Date().toISOString());
      await loadKanbanRoles(projectId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page-shell ui-board">
      <header className="ui-admin-header">
        <p className="eyebrow">看板</p>
        <h1>角色与 Runner</h1>
        <p className="lead ui-muted">
          每个 Kanban  lane 可配置<strong>多个人员</strong>，每人绑定一个 runner。自动分配时：若该任务历史上该 lane 已有负责人则继续派给 TA；否则派给当前负载（该 lane 在制任务数）最少的人。优先级：接口显式{' '}
          <code>runtimeProfileId</code> &gt; 人员绑定 &gt; 下方「单 lane 默认 runner」&gt; 任务会话已有值。
        </p>
        <nav className="ui-nav">
          <a href="/">首页</a>
          <a href="/board">返回看板</a>
          <a href="/projects">项目管理</a>
        </nav>
      </header>

      {error ? <p className="ui-banner">{error}</p> : null}
      {runnerHint ? <p className="ui-banner">{runnerHint}</p> : null}

      <section className="ui-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 className="ui-h2">项目</h2>
        {loading ? (
          <p className="ui-muted">加载中…</p>
        ) : projects.length === 0 ? (
          <p className="ui-muted">
            暂无项目，请先到 <a href="/projects">项目管理</a> 创建。
          </p>
        ) : (
          <label>
            选择项目
            <select
              className="ui-input"
              style={{ maxWidth: '420px' }}
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {projectId && kinds.length > 0 ? (
        <section key={projectId} className="ui-panel" style={{ marginBottom: '1.5rem' }}>
          <h2 className="ui-h2">人员与 Runner（多选）</h2>
          <p className="ui-muted ui-small" style={{ marginBottom: '1rem' }}>
            若某 lane 人员列表为空，则仍可使用下方「单 lane 默认 runner」或运行时默认。展示名可留空，将使用 id。
          </p>
          {kinds.map((kind) => (
            <div key={kind} style={{ marginBottom: '1.75rem' }}>
              <h3 className="ui-h3" style={{ fontSize: '1rem', marginBottom: '0.5rem' }}>
                {roleLabels[kind] ?? kind}
              </h3>
              {(members[kind] ?? []).length === 0 ? (
                <p className="ui-muted ui-small">暂无人员，点击添加。</p>
              ) : (
                <div className="ui-projects-form" style={{ gap: '0.5rem' }}>
                  {(members[kind] ?? []).map((row, index) => (
                    <div
                      key={`${projectId}-${kind}-${row.id}-${index}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr minmax(120px, 1fr) auto',
                        gap: '0.5rem',
                        alignItems: 'end',
                      }}
                    >
                      <label className="ui-small">
                        展示名
                        <input
                          className="ui-input"
                          value={row.name}
                          onChange={(e) => updateMember(kind, index, { name: e.target.value })}
                          placeholder={row.id}
                        />
                      </label>
                      <label className="ui-small">
                        人员 id（唯一）
                        <input
                          className="ui-input"
                          value={row.id}
                          onChange={(e) => updateMember(kind, index, { id: e.target.value })}
                        />
                      </label>
                      <label className="ui-small">
                        Runner
                        <select
                          className="ui-input"
                          value={row.runnerProfileId}
                          onChange={(e) => updateMember(kind, index, { runnerProfileId: e.target.value })}
                        >
                          <option value="">选择 runner</option>
                          {runners.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.label} — {r.runtime} ({r.id})
                            </option>
                          ))}
                        </select>
                      </label>
                      <button type="button" className="ui-btn ghost" onClick={() => removeMember(kind, index)}>
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <button type="button" className="ui-btn" style={{ marginTop: '0.5rem' }} onClick={() => addMemberRow(kind)}>
                添加人员
              </button>
            </div>
          ))}
          <h2 className="ui-h2" style={{ marginTop: '2rem' }}>
            Lane skills（每 lane 可选）
          </h2>
          <p className="ui-muted ui-small" style={{ marginBottom: '1rem' }}>
            扫描本机与项目目录下的 <code>.cursor/skills</code>、<code>.codex/skills</code>、<code>.claude/skills</code>、
            <code>.agent/skills</code>（及 <code>.agents/skills</code>）中的 SKILL 文件夹。下拉多选以 tag 展示；未选则使用各 lane
            的代码内置默认。
          </p>
          {skillCatalog.length === 0 ? (
            <p className="ui-muted ui-small" style={{ marginBottom: '1rem' }}>
              当前未扫描到任何 skill（或目录不存在）。配置好上述路径后刷新本页。
            </p>
          ) : null}
          {kinds.map((kind) => (
            <LaneSkillPicker
              key={`${projectId}-lane-skills-${kind}`}
              laneLabel={roleLabels[kind] ?? kind}
              catalog={skillCatalog}
              selectedIds={laneSkills[kind] ?? []}
              defaultLines={defaultLaneSkills?.[kind] ?? []}
              onChange={(ids) =>
                setLaneSkills((prev) => ({
                  ...prev,
                  [kind]: ids,
                }))
              }
            />
          ))}
          <h2 className="ui-h2" style={{ marginTop: '2rem' }}>
            单 lane 默认 runner（可选）
          </h2>
          <p className="ui-muted ui-small" style={{ marginBottom: '1rem' }}>
            当该 lane <strong>没有配置人员</strong>时使用。与旧版行为兼容。
          </p>
          <div className="ui-projects-form">
            {kinds.map((kind) => (
              <label key={`${projectId}-map-${kind}`}>
                {roleLabels[kind] ?? kind}
                <select
                  className="ui-input"
                  value={mapping[kind] ?? ''}
                  onChange={(e) =>
                    setMapping((prev) => ({
                      ...prev,
                      [kind]: e.target.value,
                    }))
                  }
                >
                  <option value="">（默认，不绑定 runner）</option>
                  {runners.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label} — {r.runtime} ({r.id})
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="ui-actions-bar" style={{ marginTop: '1.25rem' }}>
            <button type="button" className="ui-btn primary" disabled={busy} onClick={() => void save()}>
              保存
            </button>
            {savedAt ? (
              <span className="ui-muted ui-small">已保存 {new Date(savedAt).toLocaleString()}</span>
            ) : null}
          </div>
        </section>
      ) : null}
    </main>
  );
}
