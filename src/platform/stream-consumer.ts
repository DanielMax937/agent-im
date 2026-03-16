import type { SSEEvent } from '../lib/bridge/host.js';

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
}

export interface ConsumeAgentStreamOptions {
  onPermissionRequest?: (permission: PermissionRequestInfo) => Promise<void>;
}

export async function consumeAgentStream(
  stream: ReadableStream<string>,
  options: ConsumeAgentStreamOptions = {},
): Promise<StreamConsumeResult> {
  const reader = stream.getReader();
  let responseText = '';
  let hasError = false;
  let errorMessage = '';
  let providerSessionId: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

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
        const payload = JSON.parse(event.data) as { session_id?: string; is_error?: boolean };
        if (payload.session_id) {
          providerSessionId = payload.session_id;
        }
        if (payload.is_error) {
          hasError = true;
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
