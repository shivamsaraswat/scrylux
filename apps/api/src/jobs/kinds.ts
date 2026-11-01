import type { JobKind } from '@scrylux/core';

// What the API needs to know about a job kind without importing the worker's code (Phase 3 Milestone 2, FR-013, FR-063): which
// provider it needs, so the API can refuse to queue one while that provider is not configured. The worker's registry
// (worker/kinds.ts) holds the work itself. The API process never imports that, so it can never send a provider request
// (FR-070; test/worker/imports.test.ts holds it to that).
//
// Phase 3 Milestone 3 turned a yes-or-no into a choice: the provider check runs against whichever operation is configured
// ('any'), while ingesting and refreshing need an embedding provider, whether or not generation is configured (FR-030, FR-047).
export type Need = 'any' | 'embedding';

export const NEEDS: Readonly<Record<JobKind, Need>> = { provider_check: 'any', ingest_source: 'embedding', refresh_embeddings: 'embedding' };

/** The operations that are configured, as the API sees them: a provider name and where its data goes, or null. */
export interface ConfiguredOperations {
  generation: unknown;
  embedding: unknown;
}

/** Whether the provider that a kind needs is configured. */
export const isOffered = (need: Need, operations: ConfiguredOperations): boolean =>
  need === 'embedding' ? operations.embedding !== null : operations.generation !== null || operations.embedding !== null;
