import type { Project } from './types.js';

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

export interface ScmClient {
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef>;
}

function requireToken(project: Project): string {
  const tokenEnvVar = project.repository.scmTokenEnvVar;
  if (!tokenEnvVar) {
    throw new Error('Missing scmTokenEnvVar in project repository config');
  }
  const token = process.env[tokenEnvVar];
  if (!token) {
    throw new Error(`Missing SCM token in environment variable ${tokenEnvVar}`);
  }
  return token;
}

export class HttpScmClient implements ScmClient {
  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    if (input.project.repository.scmProvider === 'github') {
      return this.createGitHubPullRequest(input);
    }
    return this.createGitLabMergeRequest(input);
  }

  private async createGitHubPullRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    const token = requireToken(input.project);
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
      throw new Error(`GitHub pull request failed: ${response.status} ${await response.text()}`);
    }

    const payload = (await response.json()) as { html_url: string; number: number };
    return { url: payload.html_url, number: payload.number };
  }

  private async createGitLabMergeRequest(input: CreatePullRequestInput): Promise<PullRequestRef> {
    const token = requireToken(input.project);
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
