import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

interface ChatCompletionResponse {
  id?: string;
  object?: string;
  model?: string;
  choices?: Array<{
    message?: {
      role?: string;
      content?: string;
    };
  }>;
  session_id?: string;
  _session_id?: string;
  error?: {
    message?: string;
    type?: string;
  };
}

async function appHandle(): Promise<(request: Request) => Promise<Response>> {
  process.env.CTI_KANBAN_QUEUE_POLL_MS = '0';
  process.env.CTI_KANBAN_VERCEL_POLL_MS = '0';
  const { getPlatformContainer } = await import('../platform/container');
  const { app } = await getPlatformContainer();
  return (request: Request) => app.handle(request);
}

async function postChatCompletion(input: {
  model: string;
  prompt: string;
  sessionId?: string;
}): Promise<{ status: number; body: ChatCompletionResponse }> {
  const handle = await appHandle();
  const response = await handle(new Request('http://127.0.0.1/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: input.model,
      messages: [
        {
          role: 'user',
          content: input.prompt,
        },
      ],
      ...(input.sessionId ? { session_id: input.sessionId } : {}),
      working_directory: process.cwd(),
    }),
  }));
  const body = await response.json() as ChatCompletionResponse;
  return { status: response.status, body };
}

function assertSuccessfulCompletion(result: { status: number; body: ChatCompletionResponse }, model: string): string {
  assert.equal(result.status, 200, result.body.error?.message);
  assert.equal(result.body.object, 'chat.completion');
  assert.equal(result.body.model, model);
  assert.equal(result.body.choices?.[0]?.message?.role, 'assistant');
  assert.ok(result.body.choices?.[0]?.message?.content?.trim(), 'assistant content should be non-empty');
  assert.ok(result.body.session_id, 'session_id should be returned');
  assert.equal(result.body.session_id, result.body._session_id);
  return result.body.session_id!;
}

describe('OpenAI chat completions real providers', () => {
  it('calls real codex-login and claude providers, then starts a new provider session on model switch', { timeout: 600_000 }, async () => {
    const codex = await postChatCompletion({
      model: 'codex-login/gpt-5.5',
      prompt: 'Reply with one short sentence containing the token CTI_CODEX_REAL_OK.',
    });
    const codexSessionId = assertSuccessfulCompletion(codex, 'codex-login/gpt-5.5');

    const claude = await postChatCompletion({
      model: 'claude/mimo-v2.5-pro',
      sessionId: codexSessionId,
      prompt: 'Reply with one short sentence containing the token CTI_CLAUDE_REAL_OK.',
    });
    const claudeSessionId = assertSuccessfulCompletion(claude, 'claude/mimo-v2.5-pro');

    assert.notEqual(claudeSessionId, codexSessionId);
  });
});
