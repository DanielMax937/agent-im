import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { notifyKanbanTelegram } from './kanban-notify';
import { assertValidLocalRepositoryPath } from './repository-path';
import type { Project, ProjectDeploymentConfig } from './types';

const execFileAsync = promisify(execFile);

/**
 * When set, Kanban appends Vercel Deployment Protection bypass query params to deployment URLs in Telegram
 * (see https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection ).
 * Security: the token is embedded in chat — restrict Telegram access; omit env to send plain URLs.
 */
export function appendVercelProtectionBypassQuery(urlString: string, bypassToken?: string): string {
  const raw = (bypassToken ?? process.env.CTI_KANBAN_VERCEL_PROTECTION_BYPASS)?.trim();
  if (!raw || !urlString.startsWith('http')) return urlString;
  try {
    const u = new URL(urlString);
    u.searchParams.set('x-vercel-set-bypass-cookie', 'true');
    u.searchParams.set('x-vercel-protection-bypass', raw);
    return u.toString();
  } catch {
    return urlString;
  }
}

function deploymentEnabled(project: Project): boolean {
  return project.deployment?.enabled !== false;
}

function withDerivedDefaults(project: Project): ProjectDeploymentConfig {
  return {
    enabled: true,
    vercelProjectName: project.deployment?.vercelProjectName?.trim() || project.id,
    ...(project.deployment?.vercelScope?.trim() ? { vercelScope: project.deployment.vercelScope.trim() } : {}),
    ...(project.deployment?.productionBranch?.trim()
      ? { productionBranch: project.deployment.productionBranch.trim() }
      : {}),
    notifyTelegram: project.deployment?.notifyTelegram !== false,
    ...(project.deployment?.vercelProjectId?.trim()
      ? { vercelProjectId: project.deployment.vercelProjectId.trim() }
      : {}),
    ...(project.deployment?.vercelOrgId?.trim() ? { vercelOrgId: project.deployment.vercelOrgId.trim() } : {}),
    ...(project.deployment?.lastNotifiedDeploymentId?.trim()
      ? { lastNotifiedDeploymentId: project.deployment.lastNotifiedDeploymentId.trim() }
      : {}),
    ...(project.deployment?.applyVercelGitProductionBranchPatch === false
      ? { applyVercelGitProductionBranchPatch: false }
      : {}),
    ...(project.deployment?.restoreVercelGitProductionBranchOnClose === false
      ? { restoreVercelGitProductionBranchOnClose: false }
      : {}),
  };
}

async function runVercel(args: string[], cwd: string): Promise<void> {
  await execFileAsync('vercel', args, {
    cwd,
    env: process.env,
    timeout: 120_000,
  });
}

async function runVercelCapture(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('vercel', args, {
    cwd,
    env: process.env,
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function readLinkedProjectFile(repoPath: string): { projectId?: string; orgId?: string } {
  const file = path.join(repoPath, '.vercel', 'project.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { projectId?: unknown; orgId?: unknown };
    return {
      ...(typeof raw.projectId === 'string' && raw.projectId.trim() ? { projectId: raw.projectId.trim() } : {}),
      ...(typeof raw.orgId === 'string' && raw.orgId.trim() ? { orgId: raw.orgId.trim() } : {}),
    };
  } catch {
    return {};
  }
}

export async function ensureVercelProjectLinked(project: Project): Promise<ProjectDeploymentConfig | undefined> {
  if (!deploymentEnabled(project)) return project.deployment;

  const repoPath = project.repository.localPath.trim();
  assertValidLocalRepositoryPath(repoPath);
  const next = withDerivedDefaults(project);
  const projectName = next.vercelProjectName ?? project.id;
  const scopeArgs = next.vercelScope ? ['--scope', next.vercelScope] : [];

  try {
    await runVercel(['project', 'inspect', projectName, ...scopeArgs], repoPath);
  } catch {
    await runVercel(['project', 'add', projectName, ...scopeArgs], repoPath);
  }

  await runVercel(['link', '--yes', '--project', projectName, ...scopeArgs], repoPath);
  const linked = readLinkedProjectFile(repoPath);
  const merged: ProjectDeploymentConfig = {
    ...next,
    ...(linked.projectId ? { vercelProjectId: linked.projectId } : {}),
    ...(linked.orgId ? { vercelOrgId: linked.orgId } : {}),
  };
  await ensureVercelFrameworkPreset({ ...project, deployment: merged });
  return merged;
}

export type VercelDeploymentSummary = {
  id: string;
  url?: string;
  readyState?: string;
  readySubstate?: string;
  target?: string | null;
  meta?: {
    githubCommitRef?: string;
    githubCommitSha?: string;
    githubCommitMessage?: string;
  };
  createdAt?: number;
  readyAt?: number;
};

/**
 * Newest READY deployment for a Git branch ref (e.g. Kanban sprint branch). Includes Preview deployments
 * (`target` null / non-production), which is what Vercel creates for feature-branch pushes.
 */
export function pickLatestReadyDeploymentForGitRef(
  deployments: VercelDeploymentSummary[] | undefined,
  gitRef: string,
): VercelDeploymentSummary | undefined {
  const ref = gitRef.trim();
  if (!ref) return undefined;
  const forBranch = (deployments ?? [])
    .filter((item) => item.meta?.githubCommitRef === ref && item.readyState === 'READY')
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return forBranch[0];
}

type VercelProjectInfo = {
  id?: string;
  name?: string;
  /** Vercel framework slug, e.g. `nextjs`, or `null` when unset / Other. */
  framework?: string | null;
  link?: {
    type?: string;
    org?: string;
    repo?: string;
    productionBranch?: string;
  };
  latestDeployments?: VercelDeploymentSummary[];
};

type ParsedGitHubRemote = {
  owner: string;
  repo: string;
};

function parseGitHubRemote(remoteUrl: string): ParsedGitHubRemote | null {
  const trimmed = remoteUrl.trim();
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

async function readVercelProjectInfo(project: Project): Promise<VercelProjectInfo | null> {
  if (!deploymentEnabled(project)) return null;
  const repoPath = project.repository.localPath.trim();
  assertValidLocalRepositoryPath(repoPath);
  const idOrName = project.deployment?.vercelProjectId?.trim() || project.deployment?.vercelProjectName?.trim() || project.id;
  const { stdout } = await execFileAsync('vercel', ['api', `/v9/projects/${idOrName}`, '--raw'], {
    cwd: repoPath,
    env: process.env,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(stdout) as VercelProjectInfo;
}

function vercelProjectMatchesGitHubRemote(projectInfo: VercelProjectInfo | null, remoteUrl: string): boolean {
  if (!projectInfo?.link) return false;
  if ((projectInfo.link.type ?? '').toLowerCase() !== 'github') return false;
  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed) return false;
  return projectInfo.link.org === parsed.owner && projectInfo.link.repo === parsed.repo;
}

export async function ensureVercelGitConnection(project: Project): Promise<void> {
  if (!deploymentEnabled(project)) return;
  const repoPath = project.repository.localPath.trim();
  assertValidLocalRepositoryPath(repoPath);
  const remoteUrl = project.repository.remoteUrl.trim();
  const parsedRemote = parseGitHubRemote(remoteUrl);
  if (!parsedRemote) {
    throw new Error(`Only GitHub remotes are currently supported for automatic Vercel git connect: ${remoteUrl}`);
  }

  const infoBefore = await readVercelProjectInfo(project);
  if (vercelProjectMatchesGitHubRemote(infoBefore, remoteUrl)) return;
  if (infoBefore?.link?.org || infoBefore?.link?.repo) {
    throw new Error(
      `Vercel project is already connected to a different repository: ${infoBefore.link.org ?? '(unknown org)'}/${infoBefore.link.repo ?? '(unknown repo)'}`,
    );
  }

  await runVercel(['git', 'connect', remoteUrl], repoPath);
  const infoAfter = await readVercelProjectInfo(project);
  if (!vercelProjectMatchesGitHubRemote(infoAfter, remoteUrl)) {
    throw new Error(`Vercel git connect did not attach the expected GitHub repository: ${parsedRemote.owner}/${parsedRemote.repo}`);
  }
  await ensureVercelFrameworkPreset(project);
}

/**
 * When {@link ProjectDeploymentConfig.vercelFramework} is set, PATCH the Vercel project so the
 * framework preset matches (see Vercel REST API: update project). No-op if already equal or value empty.
 */
export async function ensureVercelFrameworkPreset(project: Project): Promise<void> {
  if (!deploymentEnabled(project)) return;
  const preset = project.deployment?.vercelFramework?.trim();
  if (!preset) return;

  const repoPath = project.repository.localPath.trim();
  assertValidLocalRepositoryPath(repoPath);
  const idOrName =
    project.deployment?.vercelProjectId?.trim() ||
    project.deployment?.vercelProjectName?.trim() ||
    project.id;
  const scopeArgs = project.deployment?.vercelScope?.trim() ? ['--scope', project.deployment.vercelScope.trim()] : [];

  const info = await readVercelProjectInfo(project);
  const current = info?.framework ?? null;
  if (current === preset || (typeof current === 'string' && current.toLowerCase() === preset.toLowerCase())) return;

  const body = JSON.stringify({ framework: preset });
  await runVercelApiPatchWithStdin(
    repoPath,
    `/v9/projects/${encodeURIComponent(idOrName)}`,
    body,
    scopeArgs,
  );
}

async function runVercelApiPatchWithStdin(repoPath: string, apiPath: string, body: string, scopeArgs: string[]): Promise<string> {
  const args = [...scopeArgs, 'api', apiPath, '--method', 'PATCH', '--input', '-', '--raw'];
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('vercel', args, {
      cwd: repoPath,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `vercel api PATCH exited with code ${code}`));
    });
    child.stdin.write(body, 'utf8');
    child.stdin.end();
  });
}

/**
 * Updates the Vercel project's Git **production branch** (server-side) so that the next
 * push/merge to that branch is built as **Production** (not Preview). Call **before** merging
 * into the sprint/iteration branch when relying on Vercel's Git integration.
 *
 * Uses the supported `PATCH /v9/projects/{idOrName}/branch` endpoint with body `{ "branch": "<name>" }`.
 * The branch **must already exist on the connected GitHub repository** (e.g. `origin/<branch>`), or Vercel returns 400.
 * The public `PATCH /v9/projects/...` body with `{ link: ... }` is rejected by current API validation.
 */
export async function patchVercelGitProductionBranch(project: Project, branchName: string): Promise<void> {
  if (!deploymentEnabled(project)) return;
  const ref = branchName.trim();
  if (!ref) throw new Error('patchVercelGitProductionBranch: empty branch name');

  const repoPath = project.repository.localPath.trim();
  assertValidLocalRepositoryPath(repoPath);
  const linked = await ensureVercelProjectLinked(project);
  const effective: Project = { ...project, ...(linked ? { deployment: linked } : {}) };
  await ensureVercelGitConnection(effective);

  const info = await readVercelProjectInfo(effective);
  if (!info?.link?.type) {
    throw new Error('Vercel project has no Git link; connect the GitHub repository in Vercel first.');
  }
  if ((info.link.productionBranch ?? '').trim() === ref) return;

  const idOrName =
    effective.deployment?.vercelProjectId?.trim() ||
    effective.deployment?.vercelProjectName?.trim() ||
    project.id;
  const scopeArgs = effective.deployment?.vercelScope?.trim() ? ['--scope', effective.deployment.vercelScope.trim()] : [];
  const body = JSON.stringify({ branch: ref });
  await runVercelApiPatchWithStdin(
    repoPath,
    `/v9/projects/${encodeURIComponent(idOrName)}/branch`,
    body,
    scopeArgs,
  );
}

/**
 * Runs `vercel deploy --prod` in the linked repository (current working tree). The caller should
 * check out the intended Git branch (e.g. base branch) before calling so the deployment matches it.
 */
export async function triggerVercelProductionDeployFromLinkedRepo(project: Project): Promise<void> {
  if (!deploymentEnabled(project)) {
    throw new Error(`Vercel deployment is disabled for project ${project.id}`);
  }
  const repoPath = project.repository.localPath.trim();
  assertValidLocalRepositoryPath(repoPath);
  const linked = await ensureVercelProjectLinked(project);
  const effective: Project = { ...project, ...(linked ? { deployment: linked } : {}) };
  const scopeArgs = effective.deployment?.vercelScope?.trim() ? ['--scope', effective.deployment.vercelScope.trim()] : [];
  await runVercelCapture(
    ['deploy', '--prod', '--yes', '-m', 'source=kanban-task-close', ...scopeArgs],
    repoPath,
  );
}

export async function rememberVercelDeploymentBranch(project: Project, branchName: string): Promise<ProjectDeploymentConfig | undefined> {
  if (!deploymentEnabled(project)) return project.deployment;
  const linked = await ensureVercelProjectLinked(project);
  await ensureVercelGitConnection({
    ...project,
    ...(linked ? { deployment: linked } : {}),
  });
  return {
    ...linked,
    productionBranch: branchName,
    lastNotifiedDeploymentId: undefined,
  };
}

type VercelInspectResult = {
  id: string;
  name?: string;
  url: string;
  target?: string;
  readyState?: string;
  aliases?: string[];
};

export type VercelDeploymentResult = {
  id: string;
  projectName: string;
  branchName: string;
  url: string;
  target?: string;
  readyState?: string;
  aliases: string[];
};

function parseDeploymentUrl(stdout: string): string {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const production = /^Production:\s+(https:\/\/\S+)/i.exec(line);
    if (production) return production[1];
  }
  for (const line of lines) {
    const preview = /^Preview:\s+(https:\/\/\S+)/i.exec(line);
    if (preview) return preview[1];
  }
  const generic = stdout.match(/https:\/\/[a-z0-9][a-z0-9-]*\.vercel\.app/gi);
  if (generic?.length) return generic[generic.length - 1];
  throw new Error(`Could not determine Vercel deployment URL from CLI output: ${stdout.slice(0, 800)}`);
}

function parseInspectResult(stdout: string): VercelInspectResult {
  const jsonStart = stdout.indexOf('{');
  if (jsonStart < 0) {
    throw new Error(`Could not parse Vercel inspect output as JSON: ${stdout.slice(0, 800)}`);
  }
  return JSON.parse(stdout.slice(jsonStart)) as VercelInspectResult;
}

async function currentGitBranch(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoPath,
    env: process.env,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export async function deployVercelFromLocalBranch(
  project: Project,
  options: {
    branchName?: string;
    meta?: Record<string, string>;
    timeout?: string;
  } = {},
): Promise<VercelDeploymentResult> {
  if (!deploymentEnabled(project)) {
    throw new Error(`Vercel deployment is disabled for project ${project.id}`);
  }

  const repoPath = project.repository.localPath.trim();
  assertValidLocalRepositoryPath(repoPath);
  const linked = await ensureVercelProjectLinked(project);
  const effectiveProject: Project = {
    ...project,
    ...(linked ? { deployment: linked } : {}),
  };
  await ensureVercelGitConnection(effectiveProject);

  const branchName = options.branchName?.trim() || (await currentGitBranch(repoPath));
  const checkedOutBranch = await currentGitBranch(repoPath);
  if (checkedOutBranch !== branchName) {
    throw new Error(`Local repository is on branch "${checkedOutBranch}", expected "${branchName}" before Vercel deploy`);
  }

  const scopeArgs = linked?.vercelScope?.trim() ? ['--scope', linked.vercelScope.trim()] : [];
  const metaArgs = Object.entries(options.meta ?? {})
    .filter(([, value]) => value.trim())
    .flatMap(([key, value]) => ['--meta', `${key}=${value}`]);
  const deployStdout = await runVercelCapture(['deploy', '--prod', '--yes', ...scopeArgs, ...metaArgs], repoPath);
  const deploymentUrl = parseDeploymentUrl(deployStdout);
  const inspectStdout = await runVercelCapture(
    ['inspect', deploymentUrl, '--wait', '--timeout', options.timeout ?? '10m', '--format=json', ...scopeArgs],
    repoPath,
  );
  const inspect = parseInspectResult(inspectStdout);

  if (inspect.readyState !== 'READY') {
    throw new Error(`Vercel deployment did not become READY for ${deploymentUrl}: ${inspect.readyState ?? 'unknown state'}`);
  }

  if (effectiveProject.deployment?.notifyTelegram !== false) {
    const telegramUrl = appendVercelProtectionBypassQuery(`https://${inspect.url}`);
    await notifyKanbanTelegram(
      `[Kanban][${project.id}] Vercel deployment succeeded.\nProject: ${inspect.name ?? linked?.vercelProjectName?.trim() ?? project.name}\nBranch: ${branchName}\nURL: ${telegramUrl}`,
    );
  }

  return {
    id: inspect.id,
    projectName: inspect.name ?? linked?.vercelProjectName?.trim() ?? project.id,
    branchName,
    url: `https://${inspect.url}`,
    target: inspect.target,
    readyState: inspect.readyState,
    aliases: inspect.aliases ?? [],
  };
}

export async function pollVercelDeploymentSuccesses(projects: Project[]): Promise<Project[]> {
  const updated: Project[] = [];
  for (const project of projects) {
    if (!deploymentEnabled(project) || project.deployment?.notifyTelegram === false) continue;
    const configuredBranch = project.deployment?.productionBranch?.trim();
    if (!configuredBranch) continue;
    const info = await readVercelProjectInfo(project);
    if (!info) continue;

    const latest = pickLatestReadyDeploymentForGitRef(info.latestDeployments, configuredBranch);
    if (!latest) continue;
    if (latest.id === project.deployment?.lastNotifiedDeploymentId) continue;

    const rawUrl = latest.url ? `https://${latest.url}` : '(missing url)';
    const deployUrl = rawUrl === '(missing url)' ? rawUrl : appendVercelProtectionBypassQuery(rawUrl);
    const sha = latest.meta?.githubCommitSha?.slice(0, 7) ?? 'unknown';
    const targetLabel =
      latest.target === 'production' ? 'production' : latest.target ? String(latest.target) : 'preview';
    await notifyKanbanTelegram(
      [
        `[Kanban][${project.id}] Vercel deployment succeeded (${targetLabel}) for Git ref \`${configuredBranch}\`.`,
        `Project: ${info.name ?? project.name}`,
        `Commit: ${sha}`,
        `URL: ${deployUrl}`,
      ].join('\n'),
    );
    updated.push({
      ...project,
      deployment: {
        ...project.deployment,
        lastNotifiedDeploymentId: latest.id,
      },
    });
  }
  return updated;
}
