import { parseLlmStatus } from '@scrylux/llm';
import { currentJobConfig } from '../jobs/config.js';
import { currentSourceConfig } from './config.js';
import { storage } from '../storage/instance.js';
import type { SourcesContext } from './store.js';

/**
 * What the source routes need to know about this install right now: the storage, the limits, the caps copied onto a new job,
 * and the configured embedding model, as the API sees them. The API holds no provider key (Phase 3 Milestone 2, FR-071), but it
 * knows which providers are configured and which model embeds, which is all that this needs.
 */
export function currentSourcesContext(): SourcesContext {
  const config = currentSourceConfig();
  const jobs = currentJobConfig();
  return {
    storage: storage(),
    config,
    jobs: {
      tokenCap: jobs.tokenCap,
      costCapUsd: jobs.costCapUsd,
      maxRuns: jobs.maxRuns,
      timeLimitMs: jobs.timeLimitMs,
      jobsPerAccount: jobs.jobsPerAccount,
      providerCheckCooldownMs: jobs.providerCheckCooldownMs,
      ingestionJobsPerAccount: config.ingestionJobsPerAccount,
    },
    embeddingModel: parseLlmStatus(process.env).embedding?.model ?? null,
  };
}
