export type FailureCategory =
  | 'not_configured'
  | 'not_authorized'
  | 'not_available'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'input_too_large'
  | 'output_limit_reached'
  | 'refused'
  | 'rejected'
  | 'invalid_output'
  | 'cancelled';

// Fixed text per category (FR-020). It never includes a key, an address, the prompt, the content or an answer,
// so the check command and later the UI can show it as it is.
export const FAILURE_MESSAGES: Readonly<Record<FailureCategory, string>> = {
  not_configured: 'No AI provider is configured for this operation.',
  not_authorized: 'The provider refused the credentials. Check the API key and its permissions.',
  not_available: 'The provider does not know this model, or it is not enabled for this account.',
  rate_limited: 'The provider is limiting requests. Try again later.',
  provider_unavailable: 'The provider did not answer in time, or reported an error. Try again later.',
  input_too_large: 'The input is too large for the model.',
  output_limit_reached: 'The answer was cut off at the output limit.',
  refused: 'The model declined to answer.',
  rejected: 'The provider rejected the request as malformed.',
  invalid_output: 'The model did not return an answer that matches the required shape.',
  cancelled: 'The request was cancelled.',
};

/** A setting is missing or malformed. The message names the variable and never a value. */
export class LlmConfigError extends Error {
  override name = 'LlmConfigError';
}

/** A programming error: the caller's schema or arguments are wrong. Thrown before any request is sent. */
export class LlmSchemaError extends Error {
  override name = 'LlmSchemaError';
}

export type RejectedParam = 'temperature' | 'format' | 'max_tokens';

/**
 * What an adapter throws for a failed call. It carries a category and a few facts the loop needs, and never the
 * provider's own error, which can echo request content.
 */
export class AdapterError extends Error {
  override name = 'AdapterError';
  readonly category: FailureCategory;
  readonly retryAfterMs?: number;
  readonly rejectedParam?: RejectedParam;
  /** Embeddings: the position of the text that was too long. */
  readonly index?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;

  constructor(
    category: FailureCategory,
    extra: {
      retryAfterMs?: number;
      rejectedParam?: RejectedParam;
      index?: number;
      inputTokens?: number;
      outputTokens?: number;
    } = {},
  ) {
    super(`provider call failed: ${category}`);
    this.category = category;
    if (extra.retryAfterMs !== undefined) this.retryAfterMs = extra.retryAfterMs;
    if (extra.rejectedParam !== undefined) this.rejectedParam = extra.rejectedParam;
    if (extra.index !== undefined) this.index = extra.index;
    if (extra.inputTokens !== undefined) this.inputTokens = extra.inputTokens;
    if (extra.outputTokens !== undefined) this.outputTokens = extra.outputTokens;
  }
}
