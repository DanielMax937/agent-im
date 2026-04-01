import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  HttpScmClient,
  isScmMergeNotMergeableError,
  resolveScmTokenForProject,
  tryGitHubTokenFromGhCli,
} from '../platform/scm-client';
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

describe('isScmMergeNotMergeableError', () => {
  const githubProject = { repository: { ...githubRepo } } as Project;

  it('detects GitHub 405 not mergeable', () => {
    const err = new Error(
      'GitHub merge PR failed: 405 {"message":"Pull Request is not mergeable","documentation_url":"https://docs.github.com/rest/pulls/pulls#merge-a-pull-request","status":"405"}',
    );
    assert.equal(isScmMergeNotMergeableError(githubProject, err), true);
  });

  it('returns false for other GitHub merge failures', () => {
    assert.equal(
      isScmMergeNotMergeableError(githubProject, new Error('GitHub merge PR failed: 403 forbidden')),
      false,
    );
  });
});

describe('HttpScmClient createPullRequest (GitHub)', () => {
  const githubProject = { repository: { ...githubRepo } } as Project;

  it('reuses existing open PR when create returns 422', async () => {
    process.env.GITHUB_TOKEN = 'test-token';
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method === 'GET' && url.includes('/pulls?') && url.includes('state=open')) {
        return new Response(JSON.stringify([{ html_url: 'https://github.com/o/r/pull/7', number: 7 }]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (method === 'POST' && url.includes('/repos/o/r/pulls') && !url.includes('?')) {
        return new Response(JSON.stringify({ message: 'A pull request already exists' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(`unexpected ${method} ${url}`, { status: 500 });
    }) as typeof fetch;
    try {
      const client = new HttpScmClient();
      const pr = await client.createPullRequest({
        project: githubProject,
        title: 'PR title',
        body: 'body',
        sourceBranch: 'dev/issue',
        targetBranch: 'feature/sprint',
      });
      assert.equal(pr.number, 7);
      assert.equal(pr.url, 'https://github.com/o/r/pull/7');
    } finally {
      globalThis.fetch = prevFetch;
      delete process.env.GITHUB_TOKEN;
    }
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
