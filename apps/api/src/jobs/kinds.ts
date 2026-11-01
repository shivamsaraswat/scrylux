import type { JobKind } from '@scrylux/core';

// What the API needs to know about a job kind without importing the worker's code (Phase 3 Milestone 2, FR-013, FR-063):
// whether it calls a model, so the API can refuse to queue one while no provider is configured. The worker's registry
// (worker/kinds.ts) holds the work itself. The API process never imports that, so it can never send a provider request
// (FR-070; test/worker/imports.test.ts holds it to that).
export const CALLS_MODEL: Readonly<Record<JobKind, boolean>> = { provider_check: true };
