import type { CallRecord } from './attempts.js';
import { costOf, findPrice } from './pricing.js';
import type { FailureCategory } from './errors.js';
import type { OperationConfig, Usage } from './types.js';

/** A rough token count for a text of this many characters: a quarter of them, rounded up (FR-032). */
export function estimateTokens(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / 4);
}

export interface UsageInput {
  operation: Usage['operation'];
  /** Null when the operation is not configured. */
  op: OperationConfig | null;
  calls: readonly CallRecord[];
  attempts: number;
  outcome: 'ok' | FailureCategory;
  temperatureApplied: boolean | null;
  startedAt: number;
  now?: number;
}

/**
 * The usage record of one request (FR-030): tokens and cost over every attempt, failed ones included (FR-031). A call
 * that got an answer without token counts has them estimated from the text and the record says so (FR-032). A call that
 * failed before any answer, such as a rate limit, has only the tokens the provider reported, which is none.
 */
export function buildUsage(input: UsageInput): Usage {
  let estimated = false;
  const tokens = input.calls.map((call) => {
    let inputTokens = call.inputTokens ?? 0;
    let outputTokens = call.outputTokens ?? 0;
    if (call.answered) {
      if (call.inputTokens === undefined) {
        inputTokens = estimateTokens(call.inputChars);
        estimated = true;
      }
      // An embedding has no output tokens.
      if (call.outputTokens === undefined && input.operation === 'generate') {
        outputTokens = estimateTokens(call.outputChars);
        estimated = true;
      }
    }
    return { inputTokens, outputTokens: input.operation === 'embed' ? 0 : outputTokens };
  });

  const price = input.op === null ? null : findPrice(input.op);
  const costUsd = costOf(tokens, price);
  return {
    operation: input.operation,
    provider: input.op?.provider ?? null,
    model: input.op?.model ?? null,
    outcome: input.outcome,
    attempts: input.attempts,
    inputTokens: tokens.reduce((sum, t) => sum + t.inputTokens, 0),
    outputTokens: tokens.reduce((sum, t) => sum + t.outputTokens, 0),
    tokensEstimated: estimated,
    costUsd,
    costEstimated: costUsd !== null && estimated,
    priceSource: price?.source ?? 'none',
    temperatureApplied: input.temperatureApplied,
    durationMs: (input.now ?? Date.now()) - input.startedAt,
  };
}
