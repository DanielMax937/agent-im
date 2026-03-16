import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JiraAdapter, type JiraApiClient, type JiraComment } from '../platform/jira-adapter';

class FakeJiraClient implements JiraApiClient {
  public comments: JiraComment[] = [];
  public createdBodies: string[] = [];

  async listIssueComments(): Promise<JiraComment[]> {
    return [...this.comments];
  }

  async createIssueComment(_issueId: string, body: string): Promise<{ id: string }> {
    this.createdBodies.push(body);
    return { id: `comment-${this.createdBodies.length}` };
  }
}

describe('JiraAdapter', () => {
  it('treats new Jira comments as inbound messages and writes agent replies back as comments', async () => {
    const client = new FakeJiraClient();
    client.comments.push({
      id: '1',
      body: 'existing comment',
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      authorId: 'user-1',
      authorName: 'Alice',
    });

    const adapter = new JiraAdapter(
      {
        instanceId: 'developer-1',
        issueId: 'ISSUE-101',
        baseUrl: 'https://jira.example.test',
        email: 'bot@example.test',
        apiToken: 'token',
        pollIntervalMs: 60_000,
      },
      client,
    );

    await adapter.start();

    client.comments.push({
      id: '2',
      body: 'please add retry logic',
      createdAt: new Date().toISOString(),
      authorId: 'user-2',
      authorName: 'Bob',
    });

    await adapter.syncOnce();
    const inbound = await adapter.consumeOne();

    assert.ok(inbound);
    assert.equal(inbound?.text, 'please add retry logic');
    assert.equal(inbound?.address.chatId, 'ISSUE-101');
    assert.equal(inbound?.address.userId, 'user-2');

    const sendResult = await adapter.send({
      address: {
        channelType: adapter.channelType,
        chatId: 'ISSUE-101',
      },
      text: 'Acknowledged. I will update the branch.',
      parseMode: 'plain',
    });

    assert.equal(sendResult.ok, true);
    assert.equal(client.createdBodies.length, 1);
    assert.match(client.createdBodies[0], /agent-im:developer-1/);

    await adapter.stop();
  });
});
