import { LlmConfigError, parseLlmConfig, type LlmConfig } from '@scrylux/llm';
import { checkJobConfig, type JobConfig } from '../jobs/config.js';
import { describeOperation, llmEnvironment, type AiKeys } from '../llm-startup.js';
import { checkSourceConfig, type SourceConfig } from '../sources/config.js';
import { checkStorageConfig, storageEnvironment, type StorageConfig, type StorageKeys } from '../storage/config.js';

// The worker's start-up check (Phase 3 Milestone 2, FR-004, SC-009): the same rules as the API's, with the provider keys
// required because the worker is the one process that uses them. It refuses a bad configuration with a line that names the
// setting and never its value, and it never contacts a provider (Milestone 1, FR-007).

export type WorkerStartup = { ok: true; line: string; llm: LlmConfig; jobs: JobConfig; sources: SourceConfig; storage: StorageConfig } | { ok: false; line: string };

/**
 * `keys` are the AI and storage keys that config.load() resolved: the environment's, overridden by the secrets-manager secret.
 * `line` is safe to log as it stands: a provider name and where its data goes, or the message of a configuration error.
 */
export function checkWorkerStartup(env: NodeJS.ProcessEnv, keys: AiKeys & StorageKeys): WorkerStartup {
  let llm: LlmConfig;
  try {
    llm = parseLlmConfig(llmEnvironment(env, keys));
  } catch (error) {
    if (!(error instanceof LlmConfigError)) throw error;
    return { ok: false, line: `Startup failed: invalid AI provider configuration: ${error.message}` };
  }
  const jobs = checkJobConfig(env);
  if (!jobs.ok) return jobs;
  // Phase 3 Milestone 3: the worker reads the originals and extracts them, so it checks the same settings as the API.
  const sources = checkSourceConfig(env);
  if (!sources.ok) return sources;
  const storage = checkStorageConfig(storageEnvironment(env, keys));
  if (!storage.ok) return storage;
  return {
    ok: true,
    line: `AI providers: generation ${describeOperation(llm.generation)}, embeddings ${describeOperation(llm.embedding)}`,
    llm,
    jobs: jobs.config,
    sources: sources.config,
    storage: storage.config,
  };
}
