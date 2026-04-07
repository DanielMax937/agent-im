import type { SSEEvent } from '../lib/bridge/host';

export interface PermissionRequestInfo {
  permissionRequestId: string;
  toolName: string;
  toolInput: string;
  suggestions?: string;
}

export interface StreamConsumeResult {
  responseText: string;
  hasError: boolean;
  errorMessage: string;
  providerSessionId: string | null;
  /** Set when optional `timeoutMs` elapsed before the stream finished. */
  timedOut?: boolean;
}

export interface ConsumeAgentStreamOptions {
  onPermissionRequest?: (permission: PermissionRequestInfo) => Promise<void>;
  /** If set, cancel the stream reader after this many ms (Kanban agent / system_check turns). */
  timeoutMs?: number;
  /** If set, each raw chunk from the readable stream is appended (for debugging batch-spec / runner SSE). */
  rawStreamChunks?: string[];
}

/** Build a human-readable line from Claude/SDK `result` payload when `is_error` is set without a separate `error` SSE. */
function formatResultPayloadError(payload: {
  result?: unknown;
  stop_reason?: string;
}): string {
  const parts: string[] = [];
  if (payload.result !== undefined && payload.result !== null && payload.result !== '') {
    const r = payload.result;
    parts.push(typeof r === 'string' ? r : JSON.stringify(r));
  }
  if (payload.stop_reason?.trim()) {
    parts.push(`stop_reason: ${payload.stop_reason.trim()}`);
  }
  return parts.join('\n').trim();
}

async function runConsume(
  reader: ReadableStreamDefaultReader<string>,
  options: ConsumeAgentStreamOptions,
): Promise<StreamConsumeResult> {
  let responseText = '';
  let hasError = false;
  let errorMessage = '';
  let providerSessionId: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    if (options.rawStreamChunks && value !== undefined) {
      options.rawStreamChunks.push(value);
    }

    for (const line of value.split('\n')) {
      if (!line.startsWith('data: ')) continue;

      let event: SSEEvent;
      try {
        event = JSON.parse(line.slice(6)) as SSEEvent;
      } catch {
        continue;
      }

      if (event.type === 'text') {
        responseText += event.data;
        continue;
      }

      if (event.type === 'error') {
        hasError = true;
        errorMessage = event.data || 'Unknown runtime error';
        continue;
      }

      if (event.type === 'permission_request') {
        if (!options.onPermissionRequest) continue;
        try {
          const permission = JSON.parse(event.data) as PermissionRequestInfo;
          await options.onPermissionRequest(permission);
        } catch {
          continue;
        }
        continue;
      }

      if (event.type !== 'status' && event.type !== 'result') continue;

      try {
        const payload = JSON.parse(event.data) as {
          session_id?: string;
          is_error?: boolean;
          result?: unknown;
          stop_reason?: string;
        };
        if (payload.session_id) {
          providerSessionId = payload.session_id;
        }
        if (payload.is_error) {
          hasError = true;
          const detail = formatResultPayloadError(payload);
          if (detail) {
            errorMessage = errorMessage.trim()
              ? `${errorMessage.trim()}\n${detail}`
              : detail;
          }
        }
      } catch {
        continue;
      }
    }
  }

  return {
    responseText: responseText.trim(),
    hasError,
    errorMessage,
    providerSessionId,
  };
}

export async function consumeAgentStream(
  stream: ReadableStream<string>,
  options: ConsumeAgentStreamOptions = {},
): Promise<StreamConsumeResult> {
  const reader = stream.getReader();
  const timeoutMs = options.timeoutMs ?? 0;

  if (timeoutMs <= 0) {
    return runConsume(reader, options);
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<StreamConsumeResult>((resolve) => {
    timeoutId = setTimeout(() => {
      void reader.cancel();
      resolve({
        responseText: '',
        hasError: true,
        errorMessage: `Kanban stream timed out after ${timeoutMs}ms`,
        providerSessionId: null,
        timedOut: true,
      });
    }, timeoutMs);
  });

  const consumePromise = runConsume(reader, options).finally(() => {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  });

  try {
    return await Promise.race([consumePromise, timeoutPromise]);
  } finally {
    await consumePromise.catch(() => {});
  }
}
