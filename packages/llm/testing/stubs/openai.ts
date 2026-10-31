import type { Scripted } from './server.js';

// Scripted answers of the Chat Completions API (POST <base>/chat/completions), as OpenAI, Azure, Ollama and vLLM serve it.

export function openaiCompletion(
  over: {
    content?: string | null;
    refusal?: string | null;
    finish_reason?: string;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  } = {},
): Scripted {
  const body: Record<string, unknown> = {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: 0,
    model: 'stub',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: over.content === undefined ? '{"name":"n","type":"a"}' : over.content, refusal: over.refusal ?? null },
        finish_reason: over.finish_reason ?? 'stop',
      },
    ],
  };
  if (over.usage !== null) body.usage = over.usage ?? { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  return { status: 200, json: body };
}

export function openaiError(
  status: number,
  message: string,
  extra: { code?: string; param?: string; type?: string; headers?: Record<string, string> } = {},
): Scripted {
  return {
    status,
    headers: extra.headers ?? {},
    json: { error: { message, type: extra.type ?? 'invalid_request_error', param: extra.param ?? null, code: extra.code ?? null } },
  };
}

/** An error with a message and nothing else, the way vLLM and Ollama often answer. */
export function plainError(status: number, message: string): Scripted {
  return { status, json: { error: { message } } };
}

/** An /embeddings answer: one vector per input, in order. */
export function openaiEmbeddings(vectors: number[][], promptTokens = vectors.length * 3): Scripted {
  return {
    status: 200,
    json: {
      object: 'list',
      model: 'stub',
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
    },
  };
}
