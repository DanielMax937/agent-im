import crypto from 'node:crypto';

import { BaseChannelAdapter } from '../lib/bridge/channel-adapter.js';
import type { InboundMessage, OutboundMessage, SendResult } from '../lib/bridge/types.js';

export interface JiraComment {
  id: string;
  body: string;
  createdAt: string;
  authorId?: string;
  authorName?: string;
}

export interface JiraApiClient {
  listIssueComments(issueId: string): Promise<JiraComment[]>;
  createIssueComment(issueId: string, body: string): Promise<{ id: string }>;
}

export interface JiraAdapterConfig {
  instanceId: string;
  issueId: string;
  baseUrl: string;
  email: string;
  apiToken: string;
  pollIntervalMs: number;
  botAccountId?: string;
}

interface JiraListResponse {
  comments?: Array<{
    id: string;
    body?: unknown;
    created?: string;
    author?: {
      accountId?: string;
      displayName?: string;
    };
  }>;
}

function toBasicAuth(email: string, apiToken: string): string {
  return Buffer.from(`${email}:${apiToken}`).toString('base64');
}

function extractCommentBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (!body || typeof body !== 'object') return '';

  const documentBody = body as {
    content?: Array<{ content?: Array<{ text?: string }> }>;
  };
  return (documentBody.content ?? [])
    .flatMap((node) => node.content ?? [])
    .map((node) => node.text ?? '')
    .join('')
    .trim();
}

export function createJiraApiClient(config: JiraAdapterConfig): JiraApiClient {
  const authHeader = `Basic ${toBasicAuth(config.email, config.apiToken)}`;

  return {
    async listIssueComments(issueId: string): Promise<JiraComment[]> {
      const response = await fetch(
        `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueId)}/comment?maxResults=100`,
        {
          headers: {
            Accept: 'application/json',
            Authorization: authHeader,
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Jira list comments failed: ${response.status} ${await response.text()}`);
      }

      const payload = (await response.json()) as JiraListResponse;
      return (payload.comments ?? []).map((comment) => ({
        id: comment.id,
        body: extractCommentBody(comment.body),
        createdAt: comment.created ?? new Date().toISOString(),
        authorId: comment.author?.accountId,
        authorName: comment.author?.displayName,
      }));
    },
    async createIssueComment(issueId: string, body: string): Promise<{ id: string }> {
      const response = await fetch(
        `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueId)}/comment`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: authHeader,
          },
          body: JSON.stringify({ body }),
        },
      );

      if (!response.ok) {
        throw new Error(`Jira create comment failed: ${response.status} ${await response.text()}`);
      }

      const payload = (await response.json()) as { id: string };
      return { id: payload.id };
    },
  };
}

export class JiraAdapter extends BaseChannelAdapter {
  private readonly queue: InboundMessage[] = [];
  private readonly waiters: Array<(message: InboundMessage | null) => void> = [];
  private readonly client: JiraApiClient;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastSeenCommentId: string | null = null;
  private readonly marker: string;

  constructor(
    private readonly config: JiraAdapterConfig,
    client?: JiraApiClient,
  ) {
    super('jira', config.instanceId);
    this.client = client ?? createJiraApiClient(config);
    this.marker = `<!-- agent-im:${config.instanceId} -->`;
  }

  validateConfig(): string | null {
    if (!this.config.baseUrl) return 'Jira base URL is required';
    if (!this.config.issueId) return 'Jira issue ID is required';
    if (!this.config.email || !this.config.apiToken) return 'Jira credentials are required';
    return null;
  }

  isAuthorized(): boolean {
    return true;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    const configError = this.validateConfig();
    if (configError) throw new Error(configError);

    const existing = await this.client.listIssueComments(this.config.issueId);
    this.lastSeenCommentId = existing.at(-1)?.id ?? null;
    this.running = true;

    this.pollHandle = setInterval(() => {
      this.syncOnce().catch((error) => {
        console.warn(`[jira-adapter:${this.instanceId}] Poll failed:`, error instanceof Error ? error.message : error);
      });
    }, this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }

    while (this.waiters.length > 0) {
      this.waiters.shift()?.(null);
    }
  }

  async consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return queued;
    if (!this.running) return null;

    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const issueId = message.address.chatId || this.config.issueId;
    const body = `${this.marker}\n${message.text}`;
    try {
      const result = await this.client.createIssueComment(issueId, body);
      return { ok: true, messageId: result.id };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async syncOnce(): Promise<void> {
    if (!this.running) return;
    const comments = await this.client.listIssueComments(this.config.issueId);
    if (comments.length === 0) return;

    let seenLast = this.lastSeenCommentId === null;
    for (const comment of comments) {
      if (!seenLast) {
        if (comment.id === this.lastSeenCommentId) {
          seenLast = true;
        }
        continue;
      }
      if (comment.id === this.lastSeenCommentId) continue;
      if (this.shouldIgnoreComment(comment)) continue;
      this.enqueueComment(comment);
    }

    this.lastSeenCommentId = comments.at(-1)?.id ?? this.lastSeenCommentId;
  }

  private shouldIgnoreComment(comment: JiraComment): boolean {
    if (!comment.body.trim()) return true;
    if (comment.body.includes(this.marker)) return true;
    if (this.config.botAccountId && comment.authorId === this.config.botAccountId) return true;
    return false;
  }

  private enqueueComment(comment: JiraComment): void {
    const message: InboundMessage = {
      messageId: comment.id || crypto.randomUUID(),
      address: {
        channelType: this.channelType,
        chatId: this.config.issueId,
        userId: comment.authorId,
        displayName: comment.authorName,
      },
      text: comment.body.trim(),
      timestamp: Date.parse(comment.createdAt) || Date.now(),
      raw: comment,
    };

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }

    this.queue.push(message);
  }
}
