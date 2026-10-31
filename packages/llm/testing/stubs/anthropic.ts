import type { Scripted } from './server.js';

// Scripted answers of Anthropic's Messages API (POST /v1/messages).

export function anthropicMessage(
  over: {
    text?: string;
    blocks?: unknown[];
    stop_reason?: string;
    usage?: Record<string, number | null>;
  } = {},
): Scripted {
  return {
    status: 200,
    json: {
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'stub',
      content: over.blocks ?? [{ type: 'text', text: over.text ?? '{"name":"n","type":"a"}' }],
      stop_reason: over.stop_reason ?? 'end_turn',
      stop_sequence: null,
      usage: over.usage ?? { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  };
}

export function anthropicError(status: number, message: string, headers: Record<string, string> = {}): Scripted {
  return { status, headers, json: { type: 'error', error: { type: 'api_error', message } } };
}
