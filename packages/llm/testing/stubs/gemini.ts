import type { Scripted } from './server.js';

// Scripted answers of the Gemini Developer API: models.generateContent
// (POST /v1beta/models/{model}:generateContent) and models.embedContent / batchEmbedContents.

export function geminiAnswer(
  over: {
    text?: string;
    parts?: unknown[];
    finishReason?: string;
    usage?: Record<string, number> | null;
    blockReason?: string;
  } = {},
): Scripted {
  const body: Record<string, unknown> = {};
  if (over.blockReason !== undefined) body.promptFeedback = { blockReason: over.blockReason };
  else {
    body.candidates = [
      {
        index: 0,
        content: { role: 'model', parts: over.parts ?? [{ text: over.text ?? '{"name":"n","type":"a"}' }] },
        finishReason: over.finishReason ?? 'STOP',
      },
    ];
  }
  if (over.usage !== null) body.usageMetadata = over.usage ?? { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 };
  return { status: 200, json: body };
}

export function geminiError(status: number, message: string, googleStatus = 'INVALID_ARGUMENT', details?: unknown[]): Scripted {
  return { status, json: { error: { code: status, message, status: googleStatus, ...(details === undefined ? {} : { details }) } } };
}

/** A batchEmbedContents answer: one embedding per request, in order. */
export function geminiEmbeddings(vectors: number[][]): Scripted {
  return { status: 200, json: { embeddings: vectors.map((values) => ({ values })) } };
}
