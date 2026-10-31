import type { Usage } from './types.js';

/**
 * The one log line of a request (FR-034): the usage record's fields and nothing else. It carries no prompt, content,
 * answer, key or address, and there is no switch to add them in this milestone.
 */
export function formatLogLine(usage: Usage): string {
  return JSON.stringify({
    event: 'llm_request',
    operation: usage.operation,
    provider: usage.provider,
    model: usage.model,
    outcome: usage.outcome,
    attempts: usage.attempts,
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    tokens_estimated: usage.tokensEstimated,
    cost_usd: usage.costUsd,
    cost_estimated: usage.costEstimated,
    price_source: usage.priceSource,
    temperature_applied: usage.temperatureApplied,
    duration_ms: usage.durationMs,
  });
}
