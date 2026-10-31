import type { JsonSchema, AnswerMode } from '../schema.js';

export interface GenerateInput {
  system: string;
  user: string;
  /** Appended to the user turn on a schema retry. Trusted text from prompts/schema-retry.md. */
  retryNote?: string;
  jsonSchema: JsonSchema;
  /** OpenAI-compatible only: whether the schema may be sent in strict mode. */
  strict?: boolean;
  schemaName: string;
  maxOutputTokens: number;
  /** 0, or undefined when the model does not accept a temperature. */
  temperature: 0 | undefined;
  mode: AnswerMode;
  /** OpenAI-compatible only. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  timeoutMs: number;
  signal: AbortSignal;
}

export type GenerateOutcome =
  | { kind: 'answer'; text: string; inputTokens?: number; outputTokens?: number }
  | { kind: 'cut_off' | 'refused'; inputTokens?: number; outputTokens?: number };

export interface EmbedOptions {
  timeoutMs: number;
  signal: AbortSignal;
}

/**
 * One provider behind one interface. An adapter makes a single call and turns the provider's answer or error into an
 * outcome or an AdapterError. It does not retry: the attempt loop does (research #9).
 */
export interface Adapter {
  generateOnce(input: GenerateInput): Promise<GenerateOutcome>;
  embedBatch(texts: readonly string[], options: EmbedOptions): Promise<{ vectors: number[][]; inputTokens?: number }>;
}

/** The user turn: the built user text, plus the retry note when this is a schema retry. */
export function userTurn(input: Pick<GenerateInput, 'user' | 'retryNote'>): string {
  return input.retryNote === undefined ? input.user : `${input.user}\n\n${input.retryNote}`;
}
