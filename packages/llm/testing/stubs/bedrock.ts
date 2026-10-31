import type { Scripted } from './server.js';

// Scripted answers of Bedrock Runtime: Converse (POST /model/{modelId}/converse) and InvokeModel
// (POST /model/{modelId}/invoke). Errors name their type in the x-amzn-errortype header, as AWS does.

export function converseAnswer(
  over: { text?: string; blocks?: unknown[]; stopReason?: string; usage?: { inputTokens: number; outputTokens: number; totalTokens: number } } = {},
): Scripted {
  return {
    status: 200,
    json: {
      output: { message: { role: 'assistant', content: over.blocks ?? [{ text: over.text ?? '{"name":"n","type":"a"}' }] } },
      stopReason: over.stopReason ?? 'end_turn',
      usage: over.usage ?? { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      metrics: { latencyMs: 1 },
    },
  };
}

export function bedrockError(status: number, type: string, message: string): Scripted {
  return { status, headers: { 'x-amzn-errortype': type }, json: { message } };
}

export function invokeAnswer(body: unknown): Scripted {
  return { status: 200, json: body };
}
