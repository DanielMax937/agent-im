/**
 * Shared helpers for Kanban full test runner (API + Chrome DevTools Server + gh).
 */
import { execFileSync, execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir, tmpdir } from 'node:os';

export function resolveGhOwner() {
  const org = process.env.KANBAN_E2E_ORG?.trim();
  if (org) return org;
  return execFileSync('gh', ['api', 'user', '-q', '.login'], { encoding: 'utf8' }).trim();
}

export function writeSelfHostedWorkflowFile(dir, labels) {
  const runsOnYaml = labels.map((l) => JSON.stringify(l)).join(', ');
  const timeoutRaw = process.env.KANBAN_E2E_GHA_JOB_TIMEOUT_MINUTES?.trim();
  const parsed = timeoutRaw ? Number(timeoutRaw) : 120;
  const timeoutMin = Math.min(360, Math.max(1, Number.isFinite(parsed) ? parsed : 120));
  const yaml = `name: Kanban E2E (self-hosted)
on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:
jobs:
  ci:
    runs-on: [${runsOnYaml}]
    timeout-minutes: ${timeoutMin}
    steps:
      - name: Smoke
        run: echo "kanban e2e self-hosted ok"
`;
  const wfDir = join(dir, '.github', 'workflows');
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, 'kanban-e2e-selfhosted.yml'), yaml, 'utf8');
}

/**
 * @param {string} repoShortName
 * @param {string} [description]
 * @param {{
 *   visibility?: 'public' | 'private';
 *   org?: string;
 *   selfHostedRunnerLabels?: string[];
 * }} [options]
 */
export function ghCreateAndPush(repoShortName, description = 'Kanban full E2E', options = {}) {
  const owner = (options.org?.trim() || resolveGhOwner());
  const visibility = options.visibility === 'private' ? 'private' : 'public';
  const visFlag = visibility === 'private' ? '--private' : '--public';
  const dir = mkdtempSync(join(tmpdir(), `kanban-${repoShortName}-`));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), `# ${repoShortName}\n`, 'utf8');
  const labels = options.selfHostedRunnerLabels;
  if (Array.isArray(labels) && labels.length > 0) writeSelfHostedWorkflowFile(dir, labels);
  execSync('git add README.md', { cwd: dir, stdio: 'pipe' });
  if (Array.isArray(labels) && labels.length > 0) {
    execSync('git add .github/workflows/kanban-e2e-selfhosted.yml', { cwd: dir, stdio: 'pipe' });
  }
  execSync('git commit -m init', { cwd: dir, shell: true, stdio: 'pipe' });
  execSync('git branch -M main', { cwd: dir, stdio: 'pipe' });
  execSync(
    `gh repo create ${owner}/${repoShortName} ${visFlag} --source=. --remote=origin --push --description "${description.replace(/"/g, '\\"')}"`,
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

function isRetryableFetchError(e) {
  if (isStaleSocketError(e)) return true;
  const c = e?.cause;
  return c?.code === 'UND_ERR_HEADERS_TIMEOUT';
}

/** HTTP fetch with JSON parse; retries once on stale keep-alive or undici headers timeout (slow local server). */
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
      if (attempt === 0 && isRetryableFetchError(e)) continue;
      throw e;
    }
  }
  throw lastErr;
}

/**
 * Poll `GET /api/kanban/monitor?taskSessionId=…` until `predicate` matches at least one row.
 * @param {(row: Record<string, unknown>) => boolean} [opts.predicate]
 */
export async function pollKanbanMonitorRows(imBase, taskSessionId, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const intervalMs = opts.intervalMs ?? 2000;
  const predicate = opts.predicate ?? (() => true);
  const start = Date.now();
  let lastRows = [];
  while (Date.now() - start < timeoutMs) {
    const r = await fetchJson(imBase, `/api/kanban/monitor?taskSessionId=${encodeURIComponent(taskSessionId)}&limit=200`);
    if (!r.ok) return { ok: false, rows: [], allRows: [], text: r.text };
    lastRows = r.data?.rows ?? [];
    const filtered = lastRows.filter(predicate);
    if (filtered.length) return { ok: true, rows: filtered, allRows: lastRows };
    await new Promise((res) => setTimeout(res, intervalMs));
  }
  return { ok: false, rows: [], allRows: lastRows, text: 'timeout' };
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

function platformDataDirForScripts() {
  const raw = process.env.CTI_KANBAN_PLATFORM_DIR?.trim();
  if (raw === 'cti-home' || raw === 'legacy') {
    return join(homedir(), '.claude-to-im', 'kanban', 'data', 'platform');
  }
  if (raw) {
    return isAbsolute(raw) ? raw : join(process.cwd(), raw);
  }
  return join(process.cwd(), 'data', 'platform');
}

function platformDbFileNameForScripts() {
  const raw = process.env.CTI_KANBAN_PLATFORM_DB_FILE?.trim();
  const name = raw || 'platform.db';
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new Error('CTI_KANBAN_PLATFORM_DB_FILE must be a basename without path separators');
  }
  return name;
}

/** Resolves platform DB path (same rules as JsonPlatformStore / CTI_KANBAN_PLATFORM_DB_FILE). */
export function getPlatformDbPath() {
  return join(platformDataDirForScripts(), platformDbFileNameForScripts());
}

export function sqliteTableExists(tableName) {
  const safe = tableName.replace(/'/g, "''");
  const query = `SELECT name FROM sqlite_master WHERE type='table' AND name='${safe}';`;
  const paths = [getPlatformDbPath()];
  if (!process.env.CTI_KANBAN_PLATFORM_DIR?.trim()) {
    paths.push(join(homedir(), '.claude-to-im', 'kanban', 'data', 'platform', platformDbFileNameForScripts()));
  }
  const tried = [];
  for (const dbPath of paths) {
    tried.push(dbPath);
    if (!existsSync(dbPath)) continue;
    try {
      const out = execFileSync('sqlite3', [dbPath, query], { encoding: 'utf8' }).trim();
      if (out === tableName) {
        return { ok: true, detail: `table ${tableName} in ${dbPath}` };
      }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, detail: `missing DB or table ${tableName}; tried: ${tried.join('; ')}` };
}

export function ensureOutDir(runId) {
  const out = join('docs', 'test-results', runId);
  mkdirSync(out, { recursive: true });
  return out;
}

/**
 * After the first push with `.github/workflows/kanban-e2e-selfhosted.yml`, poll until a workflow run
 * completes and a job's `labels` include every entry in `expectedLabels` (e.g. `self-hosted`).
 * Must run before later commits replace `runs-on` with hosted runners.
 */
export async function pollGithubActionsSelfHostedVerification(owner, repo, expectedLabels, options = {}) {
  const workflowFile = options.workflowFile || 'kanban-e2e-selfhosted.yml';
  const timeoutMs = options.timeoutMs ?? 600_000;
  const intervalMs = options.intervalMs ?? 4_000;
  const t0 = Date.now();
  let lastDetail = '';
  while (Date.now() - t0 < timeoutMs) {
    let listJson;
    try {
      listJson = execFileSync(
        'gh',
        [
          'run',
          'list',
          '-R',
          `${owner}/${repo}`,
          '--workflow',
          workflowFile,
          '--json',
          'databaseId,status,conclusion,createdAt',
          '--limit',
          '1',
        ],
        { encoding: 'utf8' },
      );
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    let runs;
    try {
      runs = JSON.parse(listJson);
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    if (!Array.isArray(runs) || runs.length === 0) {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const run = runs[0];
    if (run.status !== 'completed') {
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    let jobsPayload;
    try {
      const jobsJson = execFileSync(
        'gh',
        ['api', `repos/${owner}/${repo}/actions/runs/${run.databaseId}/jobs`],
        { encoding: 'utf8' },
      );
      jobsPayload = JSON.parse(jobsJson);
    } catch (e) {
      lastDetail = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }
    const jobs = jobsPayload?.jobs || [];
    for (const job of jobs) {
      const labels = job.labels || [];
      const missing = expectedLabels.filter((l) => !labels.includes(l));
      if (missing.length === 0) {
        return {
          ok: true,
          runId: run.databaseId,
          conclusion: run.conclusion,
          jobName: job.name,
          runnerName: job.runner_name ?? '',
          labels,
        };
      }
      lastDetail = `job "${job.name}" labels=[${labels.join(', ')}] missing [${missing.join(', ')}]`;
    }
    if (jobs.length > 0) {
      return {
        ok: false,
        reason: `run ${run.databaseId} completed but no job matched expected labels [${expectedLabels.join(', ')}]: ${lastDetail}`,
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    ok: false,
    reason: `timeout waiting for GitHub Actions self-hosted job (${timeoutMs}ms). ${lastDetail}`,
  };
}
