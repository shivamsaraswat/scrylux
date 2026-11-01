import { afterAll, describe, expect, it } from 'vitest';
import type { Database } from '../src/index.js';
import { closePool, pool } from './helpers.js';

// The Kysely `Database` interface is written by hand, so this test is what keeps it honest. The
// `satisfies` clause is the compile-time half: it rejects both a column missing from the interface
// and a column the interface does not have, so `pnpm typecheck` fails when they disagree. The
// queries below are the runtime half: the same names must match the real columns.
const COLUMNS = {
  projects: { id: true, name: true, description: true, created_by: true, created_at: true, updated_at: true },
  threat_models: {
    id: true,
    project_id: true,
    name: true,
    methodology: true,
    status: true,
    created_at: true,
    updated_at: true,
  },
  elements: {
    id: true,
    threat_model_id: true,
    type: true,
    name: true,
    properties: true,
    layout: true,
    source_element_id: true,
    target_element_id: true,
    parent_boundary_id: true,
    created_at: true,
    updated_at: true,
  },
  threats: {
    id: true,
    threat_model_id: true,
    element_id: true,
    category: true,
    title: true,
    description: true,
    likelihood: true,
    impact: true,
    risk: true,
    status: true,
    origin: true,
    library_ref: true,
    stale: true,
    status_reason: true,
    created_at: true,
    updated_at: true,
  },
  mitigations: {
    id: true,
    threat_id: true,
    description: true,
    status: true,
    external_ref: true,
    created_at: true,
    updated_at: true,
  },
  jobs: {
    id: true,
    kind: true,
    input: true,
    state: true,
    created_by: true,
    queued_at: true,
    next_run_at: true,
    started_at: true,
    deadline_at: true,
    finished_at: true,
    run: true,
    claim: true,
    max_runs: true,
    time_limit_ms: true,
    token_cap: true,
    cost_cap_usd: true,
    worker_id: true,
    lease_expires_at: true,
    cancel_requested_at: true,
    cancelled_by: true,
    progress: true,
    failure_category: true,
    failure_detail: true,
    result: true,
  },
  job_usage: {
    id: true,
    job_id: true,
    run: true,
    operation: true,
    provider: true,
    model: true,
    outcome: true,
    attempts: true,
    input_tokens: true,
    output_tokens: true,
    tokens_estimated: true,
    cost_usd: true,
    cost_estimated: true,
    price_source: true,
    temperature_applied: true,
    duration_ms: true,
    recorded_at: true,
  },
  workers: { id: true, started_at: true, last_seen_at: true, stopping: true },
} satisfies { [T in keyof Database]: Record<keyof Database[T], true> };

afterAll(closePool);

describe('the Kysely table types match the database (research #1)', () => {
  it('describes exactly the five domain tables and the three job tables', () => {
    expect(Object.keys(COLUMNS).sort()).toEqual([
      'elements',
      'job_usage',
      'jobs',
      'mitigations',
      'projects',
      'threat_models',
      'threats',
      'workers',
    ]);
  });

  for (const table of Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]) {
    it(`gives ${table} exactly its real columns`, async () => {
      const { rows } = await pool().query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      expect(rows.map((r) => r.column_name).sort()).toEqual(Object.keys(COLUMNS[table]).sort());
    });
  }
});
