import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { notifyKanbanTelegram } from './kanban-notify';
import { assertValidLocalRepositoryPath } from './repository-path';
import type { Project, ProjectDeploymentConfig } from './types';

const execFileAsync = promisify(execFile);

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
  return {
    ...next,
    ...(linked.projectId ? { vercelProjectId: linked.projectId } : {}),
    ...(linked.orgId ? { vercelOrgId: linked.orgId } : {}),
  };
}

type VercelDeploymentSummary = {
  id: string;
  url?: string;
  readyState?: string;
  readySubstate?: string;
  target?: string;
  meta?: {
    githubCommitRef?: string;
    githubCommitSha?: string;
    githubCommitMessage?: string;
  };
  createdAt?: number;
  readyAt?: number;
};

type VercelProjectInfo = {
  id?: string;
  name?: string;
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
    await notifyKanbanTelegram(
      `[Kanban][${project.id}] Vercel deployment succeeded.\nProject: ${inspect.name ?? linked?.vercelProjectName?.trim() ?? project.name}\nBranch: ${branchName}\nURL: https://${inspect.url}`,
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
    const latest = (info?.latestDeployments ?? []).find(
      (item) => item.target === 'production' && item.meta?.githubCommitRef === configuredBranch,
    );
    if (!latest || latest.readyState !== 'READY') continue;
    if (latest.id === project.deployment?.lastNotifiedDeploymentId) continue;
    const deployUrl = latest.url ? `https://${latest.url}` : '(missing url)';
    const sha = latest.meta?.githubCommitSha?.slice(0, 7) ?? 'unknown';
    await notifyKanbanTelegram(
      `[Kanban][${project.id}] Vercel production deployment succeeded.\nProject: ${info?.name ?? project.name}\nBranch: ${configuredBranch}\nCommit: ${sha}\nURL: ${deployUrl}`,
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
