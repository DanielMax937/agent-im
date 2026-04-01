import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { resolveScmTokenForProject, tryGitHubTokenFromGhCli } from '../platform/scm-client';
import type { Project } from '../platform/types';

const githubRepo = {
  remoteUrl: 'git@example.test:o/r.git',
  localPath: '/tmp/r',
  baseBranch: 'master',
  sprintBranchPrefix: 'feature/',
  taskBranchPrefix: 'dev/',
  scmProvider: 'github' as const,
  scmProject: 'o/r',
};

describe('resolveScmTokenForProject', () => {
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['MY_SCM_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITLAB_TOKEN', 'CTI_SCM_DISABLE_GH_CLI']) {
      envSnapshot[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(envSnapshot)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('prefers explicit scmTokenEnvVar when set', async () => {
    process.env.MY_SCM_TOKEN = 'from-explicit';
    const project = {
      repository: { ...githubRepo, scmTokenEnvVar: 'MY_SCM_TOKEN' },
    } as Project;
    assert.equal(await resolveScmTokenForProject(project), 'from-explicit');
  });

  it('falls back to GITHUB_TOKEN for GitHub when scmTokenEnvVar is unset', async () => {
    process.env.GITHUB_TOKEN = 'from-github';
    const project = { repository: { ...githubRepo } } as Project;
    assert.equal(await resolveScmTokenForProject(project), 'from-github');
  });

  it('falls back to GH_TOKEN when GITHUB_TOKEN is unset', async () => {
    process.env.GH_TOKEN = 'from-gh';
    const project = { repository: { ...githubRepo } } as Project;
    assert.equal(await resolveScmTokenForProject(project), 'from-gh');
  });

  it('throws a clear error when no token is available', async () => {
    process.env.CTI_SCM_DISABLE_GH_CLI = '1';
    await assert.rejects(
      () => resolveScmTokenForProject({ repository: { ...githubRepo } } as Project),
      /No SCM token/,
    );
  });
});

describe('tryGitHubTokenFromGhCli', () => {
  const prevDisable = process.env.CTI_SCM_DISABLE_GH_CLI;

  afterEach(() => {
    if (prevDisable === undefined) delete process.env.CTI_SCM_DISABLE_GH_CLI;
    else process.env.CTI_SCM_DISABLE_GH_CLI = prevDisable;
  });

  it('returns null when CTI_SCM_DISABLE_GH_CLI=1', async () => {
    process.env.CTI_SCM_DISABLE_GH_CLI = '1';
    assert.equal(await tryGitHubTokenFromGhCli(), null);
  });
});
