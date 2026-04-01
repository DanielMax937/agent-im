import { execFile } from 'node:child_process';

import type { Project } from './types';

/**
 * When no GitHub token is in env, try `gh auth token` if GitHub CLI is logged in.
 * Returns null if gh is missing, not authenticated, or times out.
 * Set `CTI_SCM_DISABLE_GH_CLI=1` to skip (e.g. unit tests).
 */
export async function tryGitHubTokenFromGhCli(): Promise<string | null> {
  if (process.env.CTI_SCM_DISABLE_GH_CLI === '1') return null;
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'token'],
      { timeout: 8000, env: process.env, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        const token = stdout?.toString().trim() ?? '';
        resolve(token.length > 0 ? token : null);
      },
    );
  });
}

export interface PullRequestRef {
  url: string;
  number?: number;
}

export interface CreatePullRequestInput {
  project: Project;
  title: string;
  body: string;
  sourceBranch: string;
  targetBranch: string;
}

/** Find an open PR/MR from `sourceBranch` into `targetBranch` (same repo). */
export interface FindOpenPullRequestInput {
  project: Project;
  sourceBranch: string;
  targetBranch: string;
}

export interface ScmClient {
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef>;
  /** Merge an open PR/MR (GitHub: merge API; GitLab: merge). */
  mergePullRequest(project: Project, pullNumber: number): Promise<void>;
  /** Post a top-level comment on the PR/MR (issue comment on GitHub). */
  postPullRequestDiscussionComment(project: Project, pullNumber: number, body: string): Promise<void>;
  /** First matching open PR/MR, or null if none. */
  findOpenPullRequest(input: FindOpenPullRequestInput): Promise<PullRequestRef | null>;
}

/**
 * Resolves the SCM API token: explicit `repository.scmTokenEnvVar` wins; then env vars;
 * for GitHub only, finally `gh auth token` when the GitHub CLI is logged in.
 */
export async function resolveScmTokenForProject(project: Project): Promise<string> {
  const repo = project.repository;
  const explicit = repo.scmTokenEnvVar?.trim();
  if (explicit) {
    const token = process.env[explicit];
    if (!token) {
      throw new Error(`Missing SCM token in environment variable ${explicit}`);
    }
    return token;
  }

  if (repo.scmProvider === 'github') {
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN'] as const) {
      const token = process.env[name];
      if (token) return token;
    }
    const fromGh = await tryGitHubTokenFromGhCli();
    if (fromGh) return fromGh;
    throw new Error(
      'No SCM token: set repository.scmTokenEnvVar, export GITHUB_TOKEN or GH_TOKEN, or run `gh auth login`',
    );
  }

  const gitlab = process.env.GITLAB_TOKEN;
  if (gitlab) return gitlab;
  throw new Error(
    'No SCM token: set repository.scmTokenEnvVar in project settings or export GITLAB_TOKEN',
  );
}

export class HttpScmClient implements ScmClient {
  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    if (input.project.repository.scmProvider === 'github') {
      return this.createGitHubPullRequest(input);
    }
    return this.createGitLabMergeRequest(input);
  }

  async mergePullRequest(project: Project, pullNumber: number): Promise<void> {
    if (project.repository.scmProvider === 'github') {
      await this.mergeGitHubPullRequest(project, pullNumber);
      return;
    }
    await this.mergeGitLabMergeRequest(project, pullNumber);
  }

  async postPullRequestDiscussionComment(project: Project, pullNumber: number, body: string): Promise<void> {
    if (project.repository.scmProvider === 'github') {
      await this.postGitHubIssueComment(project, pullNumber, body);
      return;
    }
    await this.postGitLabMrNote(project, pullNumber, body);
  }

  async findOpenPullRequest(input: FindOpenPullRequestInput): Promise<PullRequestRef | null> {
    if (input.project.repository.scmProvider === 'github') {
      return this.findGitHubOpenPullRequest(input);
    }
    return this.findGitLabOpenMergeRequest(input);
  }

  private async findGitHubOpenPullRequest(input: FindOpenPullRequestInput): Promise<PullRequestRef | null> {
    const token = await resolveScmTokenForProject(input.project);
    const base = input.project.repository.scmApiBaseUrl || 'https://api.github.com';
    const scmProject = input.project.repository.scmProject;
    const owner = scmProject.split('/')[0];
    if (!owner) {
      throw new Error(`Invalid scmProject (expected owner/repo): ${scmProject}`);
    }
    const head = `${owner}:${input.sourceBranch}`;
    const url = `${base}/repos/${scmProject}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(input.targetBranch)}&per_page=50`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub list PRs failed: ${response.status} ${text.slice(0, 500)}`);
    }
    const items = (await response.json()) as Array<{ html_url: string; number: number }>;
    if (items.length === 0) return null;
    return { url: items[0].html_url, number: items[0].number };
  }

  private async findGitLabOpenMergeRequest(input: FindOpenPullRequestInput): Promise<PullRequestRef | null> {
    const token = await resolveScmTokenForProject(input.project);
    const baseUrl = input.project.repository.scmApiBaseUrl || 'https://gitlab.com/api/v4';
    const projectEncoded = encodeURIComponent(input.project.repository.scmProject);
    const params = new URLSearchParams({
      state: 'opened',
      source_branch: input.sourceBranch,
      target_branch: input.targetBranch,
      per_page: '20',
    });
    const response = await fetch(`${baseUrl}/projects/${projectEncoded}/merge_requests?${params}`, {
      headers: { 'PRIVATE-TOKEN': token },
    });
    if (!response.ok) {
      throw new Error(`GitLab list MRs failed: ${response.status} ${await response.text()}`);
    }
    const items = (await response.json()) as Array<{ web_url: string; iid: number }>;
    if (items.length === 0) return null;
    return { url: items[0].web_url, number: items[0].iid };
  }

  private async mergeGitHubPullRequest(project: Project, pullNumber: number): Promise<void> {
    const token = await resolveScmTokenForProject(project);
    const base = project.repository.scmApiBaseUrl || 'https://api.github.com';
    const response = await fetch(`${base}/repos/${project.repository.scmProject}/pulls/${pullNumber}/merge`, {
      method: 'PUT',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ merge_method: 'merge' }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub merge PR failed: ${response.status} ${text.slice(0, 800)}`);
    }
  }

  private async postGitHubIssueComment(project: Project, issueNumber: number, body: string): Promise<void> {
    const token = await resolveScmTokenForProject(project);
    const base = project.repository.scmApiBaseUrl || 'https://api.github.com';
    const response = await fetch(`${base}/repos/${project.repository.scmProject}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub PR comment failed: ${response.status} ${text.slice(0, 500)}`);
    }
  }

  private async mergeGitLabMergeRequest(project: Project, mergeRequestIid: number): Promise<void> {
    const token = await resolveScmTokenForProject(project);
    const baseUrl = project.repository.scmApiBaseUrl || 'https://gitlab.com/api/v4';
    const response = await fetch(
      `${baseUrl}/projects/${encodeURIComponent(project.repository.scmProject)}/merge_requests/${mergeRequestIid}/merge`,
      {
        method: 'PUT',
        headers: { 'PRIVATE-TOKEN': token },
      },
    );
    if (!response.ok) {
      throw new Error(`GitLab merge MR failed: ${response.status} ${await response.text()}`);
    }
  }

  private async postGitLabMrNote(project: Project, mergeRequestIid: number, body: string): Promise<void> {
    const token = await resolveScmTokenForProject(project);
    const baseUrl = project.repository.scmApiBaseUrl || 'https://gitlab.com/api/v4';
    const response = await fetch(
      `${baseUrl}/projects/${encodeURIComponent(project.repository.scmProject)}/merge_requests/${mergeRequestIid}/notes`,
      {
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ body }),
      },
    );
    if (!response.ok) {
      throw new Error(`GitLab MR note failed: ${response.status} ${await response.text()}`);
    }
  }

  private async createGitHubPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    const token = await resolveScmTokenForProject(input.project);
    const response = await fetch(
      `${input.project.repository.scmApiBaseUrl || 'https://api.github.com'}/repos/${input.project.repository.scmProject}/pulls`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.sourceBranch,
          base: input.targetBranch,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();
      const repo = input.project.repository.scmProject;
      const head = input.sourceBranch;
      const base = input.targetBranch;
      let hint = '';
      if (response.status === 404) {
        hint =
          ` Hint (404): check repository slug "${repo}" (项目管理 → owner/repo, 区分大小写), ` +
          `token can access this repo (private 仓库无权限时 GitHub 也返回 404), ` +
          `and "${head}" exists on origin after push. PR: base="${base}" head="${head}".`;
      } else if (response.status === 422) {
        hint = ` Hint (422): often head branch "${head}" is missing on GitHub or base "${base}" is invalid. Body: ${body.slice(0, 500)}`;
      }
      throw new Error(`GitHub pull request failed: ${response.status} ${body}${hint}`);
    }

    const payload = (await response.json()) as { html_url: string; number: number };
    return { url: payload.html_url, number: payload.number };
  }

  private async createGitLabMergeRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    const token = await resolveScmTokenForProject(input.project);
    const baseUrl = input.project.repository.scmApiBaseUrl || 'https://gitlab.com/api/v4';
    const response = await fetch(
      `${baseUrl}/projects/${encodeURIComponent(input.project.repository.scmProject)}/merge_requests`,
      {
        method: 'POST',
        headers: {
          'PRIVATE-TOKEN': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: input.title,
          description: input.body,
          source_branch: input.sourceBranch,
          target_branch: input.targetBranch,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`GitLab merge request failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as { web_url: string; iid: number };
    return { url: payload.web_url, number: payload.iid };
  }
}
