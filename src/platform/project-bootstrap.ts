import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { RunnerConfig } from '../config-shared';
import type { BatchTaskPlanItem } from './batch-task-spec';
import type { KanbanAgentKind, Project, ProjectDeploymentConfig, ProjectRepository } from './types';

const execFileAsync = promisify(execFile);

export interface BootstrapProjectWorkflowInput {
  requirement: string;
  projectName?: string;
  projectId?: string;
  sprintName?: string;
  issueIdPrefix?: string;
  owner?: string;
  framework?: 'nextjs';
  repository?: Partial<ProjectRepository> & {
    repoOwner?: string;
    repoName?: string;
  };
  deployment?: Partial<ProjectDeploymentConfig>;
  kanbanRoleRunners?: Partial<Record<KanbanAgentKind, string>>;
  taskPlan?: BatchTaskPlanItem[];
  createGitHubRepo?: boolean;
  scaffoldProject?: boolean;
  assignTasks?: boolean;
}

export interface PreparedBootstrapProject {
  requirement: string;
  project: Project;
  sprintName: string;
  taskPlan?: BatchTaskPlanItem[];
  createGitHubRepo: boolean;
  scaffoldProject: boolean;
  assignTasks: boolean;
}

export interface BootstrapWorkspaceResult {
  remoteUrl: string;
  localPath: string;
  repoOwner: string;
  repoName: string;
  scmProject: string;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function slugifyProjectId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function deriveNameFromRequirement(requirement: string): string {
  const firstLine = requirement
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.slice(0, 80) || 'New Project';
}

function inferIssueIdPrefix(projectId: string): string {
  const first = projectId.split('-').find(Boolean) ?? 'PROJECT';
  return first.replace(/[^a-z0-9]/gi, '').toUpperCase() || 'PROJECT';
}

function defaultRepoRoot(): string {
  const configured = process.env.CTI_KANBAN_REPO_ROOT?.trim();
  if (configured) return configured;
  return path.join(os.homedir(), 'Desktop', 'git');
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    env: process.env,
    timeout: 240_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function fileExists(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseTaskPlan(raw: unknown): BatchTaskPlanItem[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('taskPlan must be a non-empty array when provided');
  }
  return raw.map((row, index) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      throw new Error(`taskPlan[${index}] must be an object`);
    }
    const record = row as Record<string, unknown>;
    const title = normalizeText(record.title);
    if (!title) {
      throw new Error(`taskPlan[${index}].title is required`);
    }
    const dependsOnIndicesRaw = record.dependsOnIndices;
    const dependsOnIndices = dependsOnIndicesRaw === undefined
      ? []
      : (() => {
          if (!Array.isArray(dependsOnIndicesRaw)) {
            throw new Error(`taskPlan[${index}].dependsOnIndices must be an array`);
          }
          return dependsOnIndicesRaw.map((item, depIndex) => {
            if (typeof item !== 'number' || !Number.isInteger(item)) {
              throw new Error(`taskPlan[${index}].dependsOnIndices[${depIndex}] must be an integer`);
            }
            return item;
          });
        })();
    return { title, dependsOnIndices };
  });
}

export function pickDefaultKanbanRoleRunners(
  runners: RunnerConfig[],
): Partial<Record<KanbanAgentKind, string>> {
  const choose = (preferredRuntimes: RunnerConfig['runtime'][], labelHints: string[] = []): string | undefined => {
    const byRuntime = runners.find((runner) => preferredRuntimes.includes(runner.runtime));
    const byLabel = runners.find((runner) => {
      const label = `${runner.id} ${runner.label ?? ''}`.toLowerCase();
      return labelHints.some((hint) => label.includes(hint));
    });
    return byLabel?.id ?? byRuntime?.id ?? runners[0]?.id;
  };

  return {
    'agent-dev': choose(['cursor', 'claude', 'codex', 'copilot'], ['kanban-dev', 'dev', 'cursor']),
    'pre-tester': choose(['copilot', 'claude', 'cursor', 'codex'], ['pre-test', 'tester', 'test']),
    'codex-senior': choose(['codex', 'claude', 'cursor', 'copilot'], ['codex']),
    'claude-review': choose(['claude', 'cursor', 'codex', 'copilot'], ['review', 'claude']),
    'copilot-test': choose(['copilot', 'claude', 'cursor', 'codex'], ['copilot', 'test']),
  };
}

export function parseBootstrapProjectWorkflowInput(
  raw: unknown,
  runners: RunnerConfig[],
): PreparedBootstrapProject {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Request body must be a JSON object');
  }
  const input = raw as Record<string, unknown>;
  const requirement = normalizeText(input.requirement);
  if (!requirement) throw new Error('requirement is required');

  const fallbackName = deriveNameFromRequirement(requirement);
  const projectName = normalizeText(input.projectName) || fallbackName;
  const projectId = slugifyProjectId(normalizeText(input.projectId) || projectName) || `project-${Date.now()}`;
  const sprintName = normalizeText(input.sprintName) || 'Sprint 1';
  const issueIdPrefix = normalizeText(input.issueIdPrefix) || inferIssueIdPrefix(projectId);

  const frameworkRaw = normalizeText(input.framework);
  const framework = frameworkRaw ? (() => {
    if (frameworkRaw !== 'nextjs') {
      throw new Error(`Unsupported framework: ${frameworkRaw}`);
    }
    return frameworkRaw;
  })() : 'nextjs';

  const repositoryInput =
    typeof input.repository === 'object' && input.repository !== null && !Array.isArray(input.repository)
      ? (input.repository as Record<string, unknown>)
      : {};

  const repoOwner = normalizeText(repositoryInput.repoOwner) || normalizeText(input.owner);
  const repoName = normalizeText(repositoryInput.repoName) || projectId;
  const localPath =
    normalizeText(repositoryInput.localPath) || path.join(defaultRepoRoot(), projectId);
  const remoteUrl =
    normalizeText(repositoryInput.remoteUrl) ||
    (repoOwner ? `git@github.com:${repoOwner}/${repoName}.git` : '');
  const scmProject =
    normalizeText(repositoryInput.scmProject) || (repoOwner ? `${repoOwner}/${repoName}` : '');

  const deploymentInput =
    typeof input.deployment === 'object' && input.deployment !== null && !Array.isArray(input.deployment)
      ? (input.deployment as Record<string, unknown>)
      : {};

  const explicitRunners =
    typeof input.kanbanRoleRunners === 'object' && input.kanbanRoleRunners !== null && !Array.isArray(input.kanbanRoleRunners)
      ? (input.kanbanRoleRunners as Record<string, unknown>)
      : {};
  const autoDefaults = pickDefaultKanbanRoleRunners(runners);
  const kanbanRoleRunners: Partial<Record<KanbanAgentKind, string>> = {
    'agent-dev': normalizeText(explicitRunners['agent-dev']) || autoDefaults['agent-dev'] || '',
    'pre-tester': normalizeText(explicitRunners['pre-tester']) || autoDefaults['pre-tester'] || '',
    'codex-senior': normalizeText(explicitRunners['codex-senior']) || autoDefaults['codex-senior'] || '',
    'claude-review': normalizeText(explicitRunners['claude-review']) || autoDefaults['claude-review'] || '',
    'copilot-test': normalizeText(explicitRunners['copilot-test']) || autoDefaults['copilot-test'] || '',
  };

  const missingRunners = Object.entries(kanbanRoleRunners)
    .filter(([, value]) => !value.trim())
    .map(([key]) => key);
  if (missingRunners.length > 0) {
    throw new Error(`Unable to determine default runners for lanes: ${missingRunners.join(', ')}`);
  }

  const now = new Date().toISOString();
  return {
    requirement,
    sprintName,
    taskPlan: parseTaskPlan(input.taskPlan),
    createGitHubRepo: input.createGitHubRepo !== false,
    scaffoldProject: input.scaffoldProject !== false,
    assignTasks: input.assignTasks !== false,
    project: {
      id: projectId,
      name: projectName,
      ...(normalizeText(input.owner) ? { owner: normalizeText(input.owner) } : {}),
      issueIdPrefix,
      kanbanRoleRunners,
      repository: {
        remoteUrl,
        localPath,
        baseBranch: normalizeText(repositoryInput.baseBranch) || 'main',
        sprintBranchPrefix: normalizeText(repositoryInput.sprintBranchPrefix) || 'feature/',
        taskBranchPrefix: normalizeText(repositoryInput.taskBranchPrefix) || 'task/',
        scmProvider: normalizeText(repositoryInput.scmProvider) === 'gitlab' ? 'gitlab' : 'github',
        scmProject,
      },
      deployment: {
        enabled: deploymentInput.enabled !== false,
        vercelProjectName: normalizeText(deploymentInput.vercelProjectName) || projectId,
        ...(normalizeText(deploymentInput.vercelScope) ? { vercelScope: normalizeText(deploymentInput.vercelScope) } : {}),
        notifyTelegram: deploymentInput.notifyTelegram !== false,
      },
      agents: [],
      createdAt: now,
      updatedAt: now,
      ...(framework === 'nextjs'
        ? {
            coverageCommand: 'npm test -- --coverage --coverageReporters=json-summary',
            coverageSummaryPath: 'coverage/coverage-summary.json',
          }
        : {}),
    },
  };
}

async function currentGitHubLogin(cwd: string): Promise<string> {
  return run('gh', ['api', 'user', '--jq', '.login'], cwd);
}

async function ensureNextJsScaffold(localPath: string): Promise<void> {
  if (fileExists(path.join(localPath, 'package.json'))) return;
  await fs.promises.mkdir(path.dirname(localPath), { recursive: true });
  await run(
    'npx',
    ['create-next-app@latest', localPath, '--ts', '--app', '--eslint', '--src-dir', '--use-npm', '--yes'],
    process.cwd(),
  );
}

function gitDirPath(localPath: string): string {
  return path.join(localPath, '.git');
}

async function hasAnyGitCommit(localPath: string): Promise<boolean> {
  try {
    await run('git', ['rev-parse', '--verify', 'HEAD'], localPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureGitIdentity(localPath: string): Promise<void> {
  try {
    await run('git', ['config', 'user.name'], localPath);
  } catch {
    await run('git', ['config', 'user.name', 'CTI Kanban'], localPath);
  }
  try {
    await run('git', ['config', 'user.email'], localPath);
  } catch {
    await run('git', ['config', 'user.email', 'cti-kanban@local.invalid'], localPath);
  }
}

async function ensureGitRepositoryInitialized(localPath: string, defaultBranch: string): Promise<void> {
  if (!fileExists(gitDirPath(localPath))) {
    await run('git', ['init', '-b', defaultBranch], localPath);
  }

  if (await hasAnyGitCommit(localPath)) return;

  await ensureGitIdentity(localPath);
  await run('git', ['add', '-A'], localPath);
  try {
    await run('git', ['commit', '-m', 'chore: initial scaffold'], localPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/nothing to commit|working tree clean/i.test(message)) {
      throw error;
    }
  }
}

async function ensureGitHubRepoExists(
  localPath: string,
  repoOwner: string,
  repoName: string,
  baseBranch: string,
): Promise<void> {
  const slug = `${repoOwner}/${repoName}`;
  try {
    await run('gh', ['repo', 'view', slug, '--json', 'url'], process.cwd());
  } catch {
    await run('gh', ['repo', 'create', slug, '--private'], process.cwd());
  }

  const remoteUrl = `git@github.com:${slug}.git`;
  try {
    await run('git', ['remote', 'get-url', 'origin'], localPath);
    await run('git', ['remote', 'set-url', 'origin', remoteUrl], localPath);
  } catch {
    await run('git', ['remote', 'add', 'origin', remoteUrl], localPath);
  }

  try {
    await run('git', ['ls-remote', '--heads', 'origin', baseBranch], localPath);
  } catch {
    // ignore and still attempt push
  }
  await run('git', ['push', '-u', 'origin', baseBranch], localPath);
}

export async function ensureBootstrappedWorkspace(
  input: PreparedBootstrapProject,
): Promise<BootstrapWorkspaceResult> {
  const repoOwner = input.project.repository.scmProject.includes('/')
    ? input.project.repository.scmProject.split('/')[0]!
    : normalizeText(input.project.owner) || await currentGitHubLogin(process.cwd());
  const repoName =
    input.project.repository.scmProject.includes('/')
      ? input.project.repository.scmProject.split('/')[1]!
      : input.project.id;
  const localPath = input.project.repository.localPath;
  if (input.scaffoldProject) {
    await ensureNextJsScaffold(localPath);
  } else if (!fileExists(localPath)) {
    throw new Error(`localPath does not exist and scaffoldProject=false: ${localPath}`);
  }

  await ensureGitRepositoryInitialized(localPath, input.project.repository.baseBranch);

  if (input.createGitHubRepo) {
    await ensureGitHubRepoExists(localPath, repoOwner, repoName, input.project.repository.baseBranch);
  }

  return {
    remoteUrl: `git@github.com:${repoOwner}/${repoName}.git`,
    localPath,
    repoOwner,
    repoName,
    scmProject: `${repoOwner}/${repoName}`,
  };
}
