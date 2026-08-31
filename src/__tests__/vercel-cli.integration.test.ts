import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { ensureVercelGitConnection, ensureVercelProjectLinked } from '../platform/vercel-cli';
import type { Project, ProjectDeploymentConfig } from '../platform/types';

const execFileAsync = promisify(execFile);
const shouldRun = process.env.CTI_TEST_VERCEL_REAL === '1';
const describeReal = shouldRun ? describe : describe.skip;

type ParsedGitHubRemote = {
  owner: string;
  repo: string;
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
};

type TempGitHubRepo = {
  owner: string;
  name: string;
  slug: string;
  httpsUrl: string;
  localPath: string;
  rootPath: string;
};

function parseGitHubRemote(remoteUrl: string): ParsedGitHubRemote | null {
  const trimmed = remoteUrl.trim();
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  const https = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i.exec(trimmed);
  if (https) return { owner: https[1], repo: https[2] };
  return null;
}

async function run(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    env: process.env,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function tryRun(command: string, args: string[], cwd: string): Promise<void> {
  try {
    await execFileAsync(command, args, {
      cwd,
      env: process.env,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    // best-effort cleanup only
  }
}

async function inspectVercelProject(project: Project): Promise<VercelProjectInfo> {
  const idOrName = project.deployment?.vercelProjectId?.trim() || project.deployment?.vercelProjectName?.trim() || project.id;
  const stdout = await run('vercel', ['api', `/v9/projects/${idOrName}`, '--raw'], project.repository.localPath);
  return JSON.parse(stdout) as VercelProjectInfo;
}

async function removeVercelProject(projectName: string, cwd: string): Promise<void> {
  try {
    await execFileAsync('zsh', ['-lc', `printf 'y\n' | vercel project remove ${JSON.stringify(projectName)}`], {
      cwd,
      env: process.env,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    // best-effort cleanup only
  }
}

async function currentGitHubLogin(cwd: string): Promise<string> {
  return run('gh', ['api', 'user', '--jq', '.login'], cwd);
}

async function createTempGitHubRepo(prefix: string): Promise<TempGitHubRepo> {
  const owner = await currentGitHubLogin(process.cwd());
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const name = `${prefix}-${suffix}`;
  const slug = `${owner}/${name}`;
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), `cti-gh-${prefix}-`));
  await run('gh', ['repo', 'create', slug, '--private', '--add-readme', '--clone'], rootPath);
  const localPath = path.join(rootPath, name);
  await run('git', ['config', 'user.name', 'CTI Integration Test'], localPath);
  await run('git', ['config', 'user.email', 'cti-integration@example.test'], localPath);
  const httpsUrl = `https://github.com/${slug}.git`;

  return {
    owner,
    name,
    slug,
    httpsUrl,
    localPath,
    rootPath,
  };
}

async function cleanupTempGitHubRepo(repo: TempGitHubRepo): Promise<void> {
  await tryRun('gh', ['repo', 'delete', repo.slug, '--yes'], process.cwd());
  await fs.rm(repo.rootPath, { recursive: true, force: true });
}

function makeProject(repo: TempGitHubRepo, projectName: string): Project {
  const now = new Date().toISOString();
  return {
    id: projectName,
    name: projectName,
    repository: {
      remoteUrl: repo.httpsUrl,
      localPath: repo.localPath,
      baseBranch: 'main',
      sprintBranchPrefix: 'feature/',
      taskBranchPrefix: 'dev/',
      scmProvider: 'github',
      scmProject: repo.slug,
    },
    agents: [],
    deployment: {
      enabled: true,
      vercelProjectName: projectName,
      notifyTelegram: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function withDeployment(project: Project, deployment: ProjectDeploymentConfig | undefined): Project {
  return {
    ...project,
    ...(deployment ? { deployment } : {}),
  };
}

describeReal('Vercel CLI integration', () => {
  it(
    'skips git connect when the correct GitHub repository is already connected',
    { timeout: 420_000 },
    async () => {
      const repo = await createTempGitHubRepo('cti-skip');
      const projectName = `cti-vercel-skip-${Date.now()}`;
      const project = makeProject(repo, projectName);

      try {
        const linked = await ensureVercelProjectLinked(project);
        const connectedProject = withDeployment(project, linked);
        await ensureVercelGitConnection(connectedProject);
        const before = await inspectVercelProject(connectedProject);

        await ensureVercelGitConnection(connectedProject);
        const after = await inspectVercelProject(connectedProject);

        assert.equal(before.link?.type, 'github');
        assert.equal(before.link?.org, repo.owner);
        assert.equal(before.link?.repo, repo.name);
        assert.deepEqual(after.link, before.link);
      } finally {
        await removeVercelProject(projectName, repo.localPath);
        await cleanupTempGitHubRepo(repo);
      }
    },
  );

  it(
    'automatically connects git when the Vercel project is not yet connected to any repository',
    { timeout: 420_000 },
    async () => {
      const repo = await createTempGitHubRepo('cti-connect');
      const projectName = `cti-vercel-connect-${Date.now()}`;
      const project = makeProject(repo, projectName);

      try {
        const linked = await ensureVercelProjectLinked(project);
        const unconnectedProject = withDeployment(project, linked);
        const before = await inspectVercelProject(unconnectedProject);
        assert.ok(!before.link?.org && !before.link?.repo, 'project should start without a git link');

        await ensureVercelGitConnection(unconnectedProject);
        const after = await inspectVercelProject(unconnectedProject);

        assert.equal(after.link?.type, 'github');
        assert.equal(after.link?.org, repo.owner);
        assert.equal(after.link?.repo, repo.name);
      } finally {
        await removeVercelProject(projectName, repo.localPath);
        await cleanupTempGitHubRepo(repo);
      }
    },
  );

  it(
    'fails immediately when the Vercel project is already connected to a different GitHub repository',
    { timeout: 420_000 },
    async () => {
      const expectedRepo = await createTempGitHubRepo('cti-expected');
      const alternateRepo = await createTempGitHubRepo('cti-wrong');
      const projectName = `cti-vercel-wrong-${Date.now()}`;
      const project = makeProject(expectedRepo, projectName);

      try {
        const linked = await ensureVercelProjectLinked(project);
        const connectedToWrongRepo = withDeployment(project, linked);
        await run('git', ['remote', 'set-url', 'origin', alternateRepo.httpsUrl], expectedRepo.localPath);
        await run('vercel', ['git', 'connect', alternateRepo.httpsUrl], expectedRepo.localPath);

        await assert.rejects(
          ensureVercelGitConnection(connectedToWrongRepo),
          /already connected to a different repository/i,
        );

        const after = await inspectVercelProject(connectedToWrongRepo);
        assert.equal(after.link?.type, 'github');
        assert.equal(after.link?.org, alternateRepo.owner);
        assert.equal(after.link?.repo, alternateRepo.name);
      } finally {
        await removeVercelProject(projectName, expectedRepo.localPath);
        await cleanupTempGitHubRepo(expectedRepo);
        await cleanupTempGitHubRepo(alternateRepo);
      }
    },
  );
});
