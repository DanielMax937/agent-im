'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Project, ProjectAgentProfile, ProjectDeploymentConfig, ProjectRepository } from '../../platform/types';
import { LOCAL_REPOSITORY_PATH_HINT, looksLikeRemoteRepositoryUrl } from '../../platform/repository-path';

const PROJECT_ID_RE = /^[a-zA-Z0-9_-]+$/;

type FormState = {
  id: string;
  name: string;
  owner: string;
  issueIdPrefix: string;
  isPrivate: boolean;
  deploymentEnabled: boolean;
  deploymentVercelProjectName: string;
  deploymentVercelScope: string;
  deploymentNotifyTelegram: boolean;
  remoteUrl: string;
  localPath: string;
  baseBranch: string;
  sprintBranchPrefix: string;
  taskBranchPrefix: string;
  scmProvider: ProjectRepository['scmProvider'];
  scmProject: string;
  scmApiBaseUrl: string;
  scmTokenEnvVar: string;
  agentsJson: string;
};

function emptyForm(): FormState {
  return {
    id: '',
    name: '',
    owner: '',
    issueIdPrefix: '',
    isPrivate: false,
    deploymentEnabled: true,
    deploymentVercelProjectName: '',
    deploymentVercelScope: '',
    deploymentNotifyTelegram: true,
    remoteUrl: '',
    localPath: '',
    baseBranch: 'main',
    sprintBranchPrefix: 'feature/',
    taskBranchPrefix: 'dev/',
    scmProvider: 'github',
    scmProject: '',
    scmApiBaseUrl: '',
    scmTokenEnvVar: '',
    agentsJson: '[]',
  };
}

function projectToForm(p: Project): FormState {
  const r = p.repository;
  const d = p.deployment;
  return {
    id: p.id,
    name: p.name,
    owner: p.owner ?? '',
    issueIdPrefix: p.issueIdPrefix ?? '',
    isPrivate: p.isPrivate ?? false,
    deploymentEnabled: d?.enabled !== false,
    deploymentVercelProjectName: d?.vercelProjectName ?? p.id,
    deploymentVercelScope: d?.vercelScope ?? '',
    deploymentNotifyTelegram: d?.notifyTelegram !== false,
    remoteUrl: r.remoteUrl,
    localPath: r.localPath,
    baseBranch: r.baseBranch,
    sprintBranchPrefix: r.sprintBranchPrefix,
    taskBranchPrefix: r.taskBranchPrefix,
    scmProvider: r.scmProvider,
    scmProject: r.scmProject,
    scmApiBaseUrl: r.scmApiBaseUrl ?? '',
    scmTokenEnvVar: r.scmTokenEnvVar ?? '',
    agentsJson: JSON.stringify(p.agents ?? [], null, 2),
  };
}

function parseAgentsJson(raw: string): ProjectAgentProfile[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  if (!Array.isArray(parsed)) throw new Error('agents JSON must be an array');
  return parsed as ProjectAgentProfile[];
}

function buildProjectPayload(form: FormState, existing: Project | null): Project {
  const iso = new Date().toISOString();
  const repo: ProjectRepository = {
    remoteUrl: form.remoteUrl.trim(),
    localPath: form.localPath.trim(),
    baseBranch: form.baseBranch.trim(),
    sprintBranchPrefix: form.sprintBranchPrefix.trim(),
    taskBranchPrefix: form.taskBranchPrefix.trim(),
    scmProvider: form.scmProvider,
    scmProject: form.scmProject.trim(),
  };
  const apiBase = form.scmApiBaseUrl.trim();
  const tokenEnv = form.scmTokenEnvVar.trim();
  if (apiBase) repo.scmApiBaseUrl = apiBase;
  if (tokenEnv) repo.scmTokenEnvVar = tokenEnv;

  const agents = parseAgentsJson(form.agentsJson);
  const ownerTrim = form.owner.trim();
  const prefixTrim = form.issueIdPrefix.trim();
  const deployment: ProjectDeploymentConfig = {
    enabled: form.deploymentEnabled,
  };
  const deploymentVercelProjectName = form.deploymentVercelProjectName.trim();
  const deploymentVercelScope = form.deploymentVercelScope.trim();
  if (deploymentVercelProjectName) deployment.vercelProjectName = deploymentVercelProjectName;
  if (deploymentVercelScope) deployment.vercelScope = deploymentVercelScope;
  if (!form.deploymentNotifyTelegram) deployment.notifyTelegram = false;

  return {
    id: form.id.trim(),
    name: form.name.trim(),
    ...(ownerTrim ? { owner: ownerTrim } : {}),
    ...(prefixTrim ? { issueIdPrefix: prefixTrim } : {}),
    ...(form.isPrivate ? { isPrivate: true } : {}),
    ...(existing?.kanbanRoleRunners ? { kanbanRoleRunners: existing.kanbanRoleRunners } : {}),
    ...(existing?.kanbanRoleMembers ? { kanbanRoleMembers: existing.kanbanRoleMembers } : {}),
    repository: repo,
    deployment,
    agents,
    createdAt: existing?.createdAt ?? iso,
    updatedAt: iso,
  };
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingExisting, setEditingExisting] = useState<Project | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);

  const isEditMode = editingExisting !== null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (!res.ok) throw new Error(await res.text());
      const body = (await res.json()) as Project[];
      setProjects(Array.isArray(body) ? body : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const sortedProjects = useMemo(
    () => [...projects].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [projects],
  );

  function startNew() {
    setEditingExisting(null);
    setForm(emptyForm());
    setError(null);
  }

  function startEdit(p: Project) {
    setEditingExisting(p);
    setForm(projectToForm(p));
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (!form.id.trim() || !PROJECT_ID_RE.test(form.id.trim())) {
        throw new Error('项目 ID 仅允许字母、数字、下划线与连字符（例：demo-project）');
      }
      if (!form.name.trim()) throw new Error('请填写项目名称');
      if (!form.remoteUrl.trim() || !form.localPath.trim()) throw new Error('请填写远程仓库 URL 与本地路径');
      if (looksLikeRemoteRepositoryUrl(form.localPath)) {
        throw new Error(LOCAL_REPOSITORY_PATH_HINT);
      }
      if (!form.scmProject.trim()) throw new Error('请填写 SCM 项目路径（如 org/repo）');

      let agents: ProjectAgentProfile[];
      try {
        agents = parseAgentsJson(form.agentsJson);
      } catch {
        throw new Error('agents JSON 格式无效，需为 JSON 数组');
      }

      const payload = buildProjectPayload({ ...form, agentsJson: JSON.stringify(agents) }, editingExisting);
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      const saved = (await res.json()) as Project;
      await load();
      setEditingExisting(saved);
      setForm(projectToForm(saved));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Project) {
    const ok = window.confirm(
      `确定删除项目「${p.name}」（${p.id}）？\n仅当该项目下没有 Sprint 与任务时可删除。`,
    );
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error || (await res.text()) || `HTTP ${res.status}`);
      }
      if (editingExisting?.id === p.id) startNew();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page-shell ui-board">
      <header className="ui-admin-header">
        <p className="eyebrow">平台</p>
        <h1>项目管理</h1>
        <p className="lead ui-muted">
          创建或编辑平台项目（Git 仓库、分支前缀、SCM 配置）。保存后写入{' '}
          <code className="ui-small">data/platform/projects.json</code>。
        </p>
        <nav className="ui-nav">
          <a href="/">首页</a>
          <a href="/board">任务看板</a>
          <a href="/admin">管理后台</a>
          <button type="button" className="ui-btn ghost" disabled={busy} onClick={() => void load()}>
            刷新列表
          </button>
          <button type="button" className="ui-btn secondary" disabled={busy} onClick={startNew}>
            新建项目
          </button>
        </nav>
      </header>

      {error ? <p className="ui-banner">{error}</p> : null}

      <section className="ui-panel" style={{ marginBottom: '1.5rem' }}>
        <h2 className="ui-h2">项目列表</h2>
        {loading ? (
          <p className="ui-muted">加载中…</p>
        ) : sortedProjects.length === 0 ? (
          <p className="ui-muted">暂无项目，点击「新建项目」添加。</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="ui-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>名称</th>
                  <th>本地路径</th>
                  <th>SCM</th>
                  <th style={{ width: '180px' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {sortedProjects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <span className="ui-mono">{p.id}</span>
                    </td>
                    <td>{p.name}</td>
                    <td>
                      <span className="ui-mono" style={{ fontSize: '11px' }}>
                        {p.repository.localPath}
                      </span>
                    </td>
                    <td>
                      {p.repository.scmProvider} · {p.repository.scmProject}
                      {(p as { isPrivate?: boolean }).isPrivate ? (
                        <span style={{ marginLeft: 6, fontSize: '0.75rem', color: '#94a3b8' }} title="私有仓库 — Self-Hosted Runner CI">🔒</span>
                      ) : null}
                      {p.deployment?.enabled !== false ? (
                        <span style={{ marginLeft: 6, fontSize: '0.75rem', color: '#94a3b8' }} title="启用自动部署 workflow 约束">deploy</span>
                      ) : null}
                    </td>
                    <td>
                      <div className="ui-actions">
                        <button
                          type="button"
                          className="ui-btn secondary"
                          disabled={busy}
                          onClick={() => startEdit(p)}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="ui-btn danger"
                          disabled={busy}
                          onClick={() => void remove(p)}
                        >
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="ui-panel">
        <h2 className="ui-h2">{isEditMode ? `编辑：${editingExisting?.id}` : '新建项目'}</h2>
        <p className="ui-muted ui-small" style={{ marginBottom: '1rem' }}>
          {isEditMode ? '项目 ID 创建后不可在此修改；若需改名请删除后重建或手动改 JSON。' : '新建时请填写唯一 ID。'}
        </p>

        <div className="ui-projects-form">
          <label>
            项目 ID *
            <input
              className="ui-input"
              value={form.id}
              disabled={isEditMode}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              placeholder="demo-project"
              autoComplete="off"
            />
          </label>
          <label>
            名称 *
            <input
              className="ui-input"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="演示项目"
            />
          </label>
          <label>
            负责人（可选）
            <input
              className="ui-input"
              value={form.owner}
              onChange={(e) => setForm((f) => ({ ...f, owner: e.target.value }))}
              placeholder="@user"
            />
          </label>
          <label>
            Issue ID 前缀（可选）
            <input
              className="ui-input"
              value={form.issueIdPrefix}
              onChange={(e) => setForm((f) => ({ ...f, issueIdPrefix: e.target.value }))}
              placeholder="留空则取项目 ID 首段，如 demo-app → DEMO"
            />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            远程 URL *
            <input
              className="ui-input"
              value={form.remoteUrl}
              onChange={(e) => setForm((f) => ({ ...f, remoteUrl: e.target.value }))}
              placeholder="git@github.com:org/repo.git"
            />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            本地路径 *
            <span className="ui-muted ui-small" style={{ display: 'block', marginBottom: '0.35rem', fontWeight: 'normal' }}>
              填本机已 clone 的仓库根目录（绝对路径）。勿填 git@… / https://…（那些填在「远程 URL」）。
            </span>
            <input
              className="ui-input"
              value={form.localPath}
              onChange={(e) => setForm((f) => ({ ...f, localPath: e.target.value }))}
              placeholder="/Users/you/workspace/todolist"
            />
          </label>
          <label>
            主分支 *
            <input
              className="ui-input"
              value={form.baseBranch}
              onChange={(e) => setForm((f) => ({ ...f, baseBranch: e.target.value }))}
            />
          </label>
          <label>
            Sprint 分支前缀 *
            <input
              className="ui-input"
              value={form.sprintBranchPrefix}
              onChange={(e) => setForm((f) => ({ ...f, sprintBranchPrefix: e.target.value }))}
              placeholder="feature/"
            />
          </label>
          <label>
            任务分支前缀 *
            <input
              className="ui-input"
              value={form.taskBranchPrefix}
              onChange={(e) => setForm((f) => ({ ...f, taskBranchPrefix: e.target.value }))}
              placeholder="dev/"
            />
          </label>
          <label>
            SCM *
            <select
              className="ui-input"
              value={form.scmProvider}
              onChange={(e) =>
                setForm((f) => ({ ...f, scmProvider: e.target.value as ProjectRepository['scmProvider'] }))
              }
            >
              <option value="github">GitHub</option>
              <option value="gitlab">GitLab</option>
            </select>
          </label>
          <label>
            SCM 项目路径 *
            <input
              className="ui-input"
              value={form.scmProject}
              onChange={(e) => setForm((f) => ({ ...f, scmProject: e.target.value }))}
              placeholder="org/repo"
            />
          </label>
          <label>
            SCM API Base URL（可选）
            <input
              className="ui-input"
              value={form.scmApiBaseUrl}
              onChange={(e) => setForm((f) => ({ ...f, scmApiBaseUrl: e.target.value }))}
              placeholder="https://gitlab.example.com/api/v4"
            />
          </label>
          <label>
            Token 环境变量名（可选）
            <input
              className="ui-input"
              value={form.scmTokenEnvVar}
              onChange={(e) => setForm((f) => ({ ...f, scmTokenEnvVar: e.target.value }))}
              placeholder="GITHUB_TOKEN"
            />
          </label>
          <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.isPrivate}
              onChange={(e) => setForm((f) => ({ ...f, isPrivate: e.target.checked }))}
            />
            <span>
              私有仓库（使用 Self-Hosted Runner 进行 CI）
              <span className="ui-muted" style={{ fontSize: '0.78rem', marginLeft: '0.5rem' }}>
                启用后，回归测试阶段不启动 AI agent，改为等待 GitHub Actions self-hosted runner webhook 回调
              </span>
            </span>
          </label>
          <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.deploymentEnabled}
              onChange={(e) => setForm((f) => ({ ...f, deploymentEnabled: e.target.checked }))}
            />
            <span>
              合并后自动部署要求
              <span className="ui-muted" style={{ fontSize: '0.78rem', marginLeft: '0.5rem' }}>
                默认开启。开启后，平台会在项目创建和 sprint 启动时配置 Vercel；合并并 push 到当前迭代分支后，由 Vercel 自动构建，平台侧轮询成功结果并发送 Telegram 通知
              </span>
            </span>
          </label>
          <label>
            Vercel 项目名
            <input
              className="ui-input"
              value={form.deploymentVercelProjectName}
              onChange={(e) => setForm((f) => ({ ...f, deploymentVercelProjectName: e.target.value }))}
              placeholder="默认使用项目 ID"
            />
          </label>
          <label>
            Vercel Scope（可选）
            <input
              className="ui-input"
              value={form.deploymentVercelScope}
              onChange={(e) => setForm((f) => ({ ...f, deploymentVercelScope: e.target.value }))}
              placeholder="team-slug"
            />
          </label>
          <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.deploymentNotifyTelegram}
              onChange={(e) => setForm((f) => ({ ...f, deploymentNotifyTelegram: e.target.checked }))}
            />
            <span>Vercel 部署成功后发送 Telegram 通知</span>
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            Agent 配置（JSON 数组，可选）
            <textarea
              className="ui-input"
              rows={6}
              value={form.agentsJson}
              onChange={(e) => setForm((f) => ({ ...f, agentsJson: e.target.value }))}
              spellCheck={false}
              style={{ fontFamily: 'ui-monospace, monospace', resize: 'vertical' }}
            />
          </label>
        </div>

        <div className="ui-actions-bar" style={{ marginTop: '1.25rem' }}>
          <button type="button" className="ui-btn primary" disabled={busy} onClick={() => void save()}>
            保存
          </button>
          <button type="button" className="ui-btn ghost" disabled={busy} onClick={startNew}>
            清空表单
          </button>
        </div>
      </section>
    </main>
  );
}
