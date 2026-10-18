import type pg from 'pg';
import {
  DESCRIPTION_MAX_LENGTH,
  ELEMENT_TYPES,
  IMPACTS,
  LIKELIHOODS,
  METHODOLOGIES,
  MITIGATION_STATUSES,
  NAME_MAX_LENGTH,
  RISK_LEVELS,
  STRIDE_CATEGORIES,
  THREAT_MODEL_STATUSES,
  THREAT_ORIGINS,
  THREAT_STATUSES,
  URL_MAX_LENGTH,
  deriveRisk,
} from '@scrylux/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closePool,
  createProject,
  createThreat,
  createThreatModel,
  createUser,
  deleteProjects,
  pool,
} from './helpers.js';

// FR-037 / SC-004: the shared definitions and storage must accept exactly the same values.
// Probing with inserts can only show that a value is accepted or rejected, never that two sets
// are equal, so this reads the CHECK definitions back out of Postgres and compares them as sets.

async function constraintDefinition(db: pg.Pool | pg.PoolClient, table: string, name: string): Promise<string> {
  const { rows } = await db.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2`,
    [table, name],
  );
  const def = rows[0]?.def;
  if (def === undefined) throw new Error(`constraint ${name} not found on ${table}`);
  return def;
}

// Postgres prints the allowed values as 'value'::text, whether the CHECK was written as IN (...)
// or collapsed to a single equality.
function allowedValues(definition: string): Set<string> {
  const literals = [...definition.matchAll(/'((?:[^']|'')*)'::text/g)].map((m) => (m[1] ?? '').replaceAll("''", "'"));
  return new Set(literals);
}

const enumerations: Array<[string, string, string, readonly string[]]> = [
  ['threat_models', 'threat_models_methodology_check', 'methodology', METHODOLOGIES],
  ['threat_models', 'threat_models_status_check', 'threat model status', THREAT_MODEL_STATUSES],
  ['elements', 'elements_type_check', 'element type', ELEMENT_TYPES],
  ['threats', 'threats_category_check', 'STRIDE category', STRIDE_CATEGORIES],
  ['threats', 'threats_likelihood_check', 'likelihood', LIKELIHOODS],
  ['threats', 'threats_impact_check', 'impact', IMPACTS],
  ['threats', 'threats_status_check', 'threat status', THREAT_STATUSES],
  ['threats', 'threats_origin_check', 'threat origin', THREAT_ORIGINS],
  ['mitigations', 'mitigations_status_check', 'mitigation status', MITIGATION_STATUSES],
];

describe('enumerated values: the shared definition and storage accept the same set (FR-037)', () => {
  afterAll(closePool);

  it.each(enumerations)('%s.%s (%s)', async (table, name, _label, values) => {
    const stored = allowedValues(await constraintDefinition(pool(), table, name));
    expect(stored).toEqual(new Set(values));
  });

  it('detects drift: a value added to storage only makes the sets differ', async () => {
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE threats DROP CONSTRAINT threats_status_check');
      await client.query(
        `ALTER TABLE threats ADD CONSTRAINT threats_status_check
           CHECK (status IN ('open', 'mitigated', 'accepted', 'not_applicable', 'archived'))`,
      );
      const stored = allowedValues(await constraintDefinition(client, 'threats', 'threats_status_check'));
      expect(stored).not.toEqual(new Set(THREAT_STATUSES));
      expect(stored.has('archived')).toBe(true);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('length limits: the shared definition is never looser than storage', () => {
  afterAll(closePool);

  const limits: Array<[string, string, number]> = [
    ['projects', 'projects_name_check', NAME_MAX_LENGTH],
    ['projects', 'projects_description_check', DESCRIPTION_MAX_LENGTH],
    ['threat_models', 'threat_models_name_check', NAME_MAX_LENGTH],
    ['elements', 'elements_name_check', NAME_MAX_LENGTH],
    ['threats', 'threats_library_ref_check', NAME_MAX_LENGTH],
    ['mitigations', 'mitigations_description_check', DESCRIPTION_MAX_LENGTH],
    ['mitigations', 'mitigations_external_ref_check', URL_MAX_LENGTH],
  ];

  it.each(limits)('%s.%s is at most %i', async (table, name, expected) => {
    const def = await constraintDefinition(pool(), table, name);
    expect([...def.matchAll(/<=\s*(\d+)/g)].map((m) => Number(m[1]))).toEqual([expected]);
  });

  it('puts no maximum on threat title or description in storage; the input schemas cap them (M3 FR-031)', async () => {
    expect(await constraintDefinition(pool(), 'threats', 'threats_title_check')).not.toMatch(/<=/);
    const { rows } = await pool().query(
      `SELECT 1 FROM pg_constraint WHERE conrelid = 'threats'::regclass AND pg_get_constraintdef(oid) ILIKE '%description%'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe('risk: the shared derivation equals the stored one (FR-023, FR-035, SC-004)', () => {
  let projectId: string;
  let modelId: string;

  beforeAll(async () => {
    const project = await createProject((await createUser()).id);
    projectId = project.id;
    modelId = (await createThreatModel(projectId)).id;
  });
  afterAll(async () => {
    await deleteProjects([projectId]);
    await closePool();
  });

  it('agrees for all nine likelihood × impact pairs, and both produce every risk level', async () => {
    const seen = new Set<string>();
    for (const likelihood of LIKELIHOODS) {
      for (const impact of IMPACTS) {
        const threat = await createThreat(modelId, { likelihood, impact });
        const { rows } = await pool().query<{ risk: string }>('SELECT risk FROM threats WHERE id = $1', [threat.id]);
        expect(rows[0]?.risk, `${likelihood} / ${impact}`).toBe(deriveRisk(likelihood, impact));
        seen.add(deriveRisk(likelihood, impact));
      }
    }
    expect(seen).toEqual(new Set(RISK_LEVELS));
  });
});
