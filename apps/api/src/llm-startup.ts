import { LlmConfigError, parseLlmStatus, type LlmStatus } from '@scrylux/llm';

// The AI provider layer's start-up check (Phase 3 Milestone 1). It validates the configuration and never contacts a
// provider (FR-007), so a provider that is down, or a local model that starts later, does not stop Scrylux starting.

/** The AI keys that `config.load()` resolved: the environment's, overridden by the secrets-manager secret. */
export interface AiKeys {
  llmApiKey?: string | undefined;
  embeddingApiKey?: string | undefined;
}

/** The environment with the resolved keys put back in, which is what parseLlmConfig reads. */
export function llmEnvironment(env: NodeJS.ProcessEnv, keys: AiKeys): NodeJS.ProcessEnv {
  return {
    ...env,
    ...(keys.llmApiKey === undefined ? {} : { LLM_API_KEY: keys.llmApiKey }),
    ...(keys.embeddingApiKey === undefined ? {} : { EMBEDDING_API_KEY: keys.embeddingApiKey }),
  };
}

export type LlmStartupCheck = { ok: true; line: string } | { ok: false; line: string };

/** “anthropic (hosted)”, or “off”: a provider name and where its data goes, never a model, an address or a key. */
export const describeOperation = (op: LlmStatus['generation']): string => (op === null ? 'off' : `${op.provider} (${op.hosted ? 'hosted' : 'local'})`);

/**
 * `line` is safe to log as it stands: it holds a provider name and hosted or local, or the message of a configuration
 * error, which names a variable and never a value. It has no model, address or key.
 */
export function checkLlmConfig(env: NodeJS.ProcessEnv, keys: AiKeys): LlmStartupCheck {
  try {
    // The API holds no provider key (FR-071): it reports whether AI is configured and starts without one. A key that is set
    // is still checked like any other setting. The worker requires the key, and checks it when it starts.
    const status = parseLlmStatus(llmEnvironment(env, keys));
    return { ok: true, line: `AI providers: generation ${describeOperation(status.generation)}, embeddings ${describeOperation(status.embedding)}` };
  } catch (error) {
    if (!(error instanceof LlmConfigError)) throw error;
    return { ok: false, line: `Startup failed: invalid AI provider configuration: ${error.message}` };
  }
}
