/**
 * Shared helpers for Kanban full test runner (API + Chrome DevTools Server + gh).
 */
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';

export function resolveGhOwner() {
  const org = process.env.KANBAN_E2E_ORG?.trim();
  if (org) return org;
  return execFileSync('gh', ['api', 'user', '-q', '.login'], { encoding: 'utf8' }).trim();
}

export function ghCreateAndPush(repoShortName, description = 'Kanban full E2E') {
  const owner = resolveGhOwner();
  const dir = mkdtempSync(join(tmpdir(), `kanban-${repoShortName}-`));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), `# ${repoShortName}\n`, 'utf8');
  execSync('git add README.md && git commit -m init', { cwd: dir, shell: true, stdio: 'pipe' });
  execSync('git branch -M main', { cwd: dir, stdio: 'pipe' });
  execSync(
    `gh repo create ${owner}/${repoShortName} --public --source=. --remote=origin --push --description "${description.replace(/"/g, '\\"')}"`,
    { cwd: dir, stdio: 'pipe' },
  );
  const remoteUrl = `https://github.com/${owner}/${repoShortName}`;
  return { dir, remoteUrl, scmProject: `${owner}/${repoShortName}`, owner };
}

export function projectBody(id, localPath, remoteUrl, scmProject, extra = {}) {
  return {
    id,
    name: id,
    issueIdPrefix: 'E2E',
    repository: {
      remoteUrl,
      localPath,
      baseBranch: 'main',
      sprintBranchPrefix: 'feature/',
      taskBranchPrefix: 'dev/',
      scmProvider: 'github',
      scmProject,
      ...extra.repository,
    },
    agents: [],
    ...extra,
  };
}

function isStaleSocketError(e) {
  const c = e?.cause;
  return c?.code === 'ECONNRESET' || c?.code === 'EPIPE' || e?.code === 'ECONNRESET';
}

/** HTTP fetch with JSON parse; retries once on stale keep-alive (e.g. long gh between requests). */
export async function fetchJson(base, path, init) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${base}${path}`, init);
      const text = await r.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { _raw: text };
      }
      return { ok: r.ok, status: r.status, data, text };
    } catch (e) {
      lastErr = e;
      if (attempt === 0 && isStaleSocketError(e)) continue;
      throw e;
    }
  }
  throw lastErr;
}

export async function cdsPost(cdsBase, endpoint, body = {}) {
  const r = await fetch(`${cdsBase}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { _raw: text };
  }
  return { ok: r.ok, status: r.status, data, text };
}

export async function getFirstRunnerId(imBase) {
  const r = await fetchJson(imBase, '/api/platform/runners');
  if (!r.ok || !r.data?.runners?.length) return null;
  return r.data.runners[0].id;
}

export async function applyKanbanRunners(imBase, projectId, runnerId) {
  const kinds = ['agent-dev', 'pre-tester', 'codex-senior', 'claude-review', 'copilot-test'];
  const body = { kanbanRoleRunners: Object.fromEntries(kinds.map((k) => [k, runnerId])) };
  return fetchJson(imBase, `/api/projects/${encodeURIComponent(projectId)}/kanban-roles`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function postProject(imBase, body) {
  return fetchJson(imBase, '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function writeCase(outDir, id, pass, body) {
  const status = pass ? 'PASS' : 'FAIL';
  writeFileSync(join(outDir, `${id}.md`), `# ${id} — ${status}\n\n${String(body).trim()}\n`, 'utf8');
}

export async function pollTaskState(imBase, taskSessionId, allowed, timeoutMs = 120000, intervalMs = 2000) {
  const re = new RegExp(`^(${allowed})$`);
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await fetchJson(imBase, `/api/tasks/${encodeURIComponent(taskSessionId)}`);
    const st = r.data?.workflowState;
    if (typeof st === 'string' && re.test(st)) return { ok: true, state: st, data: r.data };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const last = await fetchJson(imBase, `/api/tasks/${encodeURIComponent(taskSessionId)}`);
  return { ok: false, state: last.data?.workflowState, data: last.data };
}

export function execGit(cwd, args) {
  execFileSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

/** Resolves default platform DB path (same rules as JsonPlatformStore). */
export function getPlatformDbPath() {
  const raw = process.env.CTI_KANBAN_PLATFORM_DIR?.trim();
  let dir;
  if (!raw || raw === 'cti-home' || raw === 'legacy') return null;
  dir = isAbsolute(raw) ? raw : join(process.cwd(), raw);
  return join(dir, 'platform.db');
}

export function sqliteTableExists(tableName) {
  const dbPath = getPlatformDbPath();
  if (!dbPath || !existsSync(dbPath)) return { ok: false, detail: dbPath ? `missing ${dbPath}` : 'CTI_KANBAN_PLATFORM_DIR unset or cti-home' };
  try {
    const out = execFileSync(
      'sqlite3',
      [dbPath, `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName.replace(/'/g, "''")}';`],
      { encoding: 'utf8' },
    ).trim();
    return { ok: out === tableName, detail: out || 'no row' };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

export function ensureOutDir(runId) {
  const out = join('docs', 'test-results', runId);
  mkdirSync(out, { recursive: true });
  return out;
}
