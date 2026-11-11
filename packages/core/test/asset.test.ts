import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AssetInput,
  AssetRecord,
  AssetUpdate,
  AssumptionInput,
  AssumptionRecord,
  AssumptionUpdate,
  DESCRIPTION_MAX_LENGTH,
  MAX_ASSETS,
  MAX_ASSUMPTIONS,
} from '../src/index.js';

// The two records Phase 3 Milestone 5 adds to a threat model (data-model.md, "The API records"). Every body is strict, so a client can
// never send provenance (FR-017) or a threat model id of its own: the threat model is in the path.

const now = '2026-11-10T00:00:00.000Z';

describe('limits', () => {
  it('allows 200 assets and 200 assumptions in a threat model (research #6)', () => {
    expect(MAX_ASSETS).toBe(200);
    expect(MAX_ASSUMPTIONS).toBe(200);
  });
});

describe('AssetInput', () => {
  it('takes a name, a description and holders, which default to none', () => {
    expect(AssetInput.parse({ name: '  Session tokens ', description: 'Bearer tokens.' })).toEqual({ name: 'Session tokens', description: 'Bearer tokens.', holder_ids: [] });
    const holder = randomUUID();
    expect(AssetInput.parse({ name: 'Tokens', description: 'Bearer tokens.', holder_ids: [holder] }).holder_ids).toEqual([holder]);
  });

  it('is strict: an unknown key, provenance and a threat model id are refused', () => {
    const base = { name: 'Tokens', description: 'Bearer tokens.' };
    expect(AssetInput.safeParse({ ...base, provenance: { rationale: 'x' } }).success).toBe(false);
    expect(AssetInput.safeParse({ ...base, threat_model_id: randomUUID() }).success).toBe(false);
    expect(AssetInput.safeParse({ ...base, origin: 'ai' }).success).toBe(false);
  });

  it('needs a name of 1 to 200 characters and a description of 1 to 10,000, trimmed', () => {
    expect(AssetInput.safeParse({ name: '   ', description: 'd' }).success).toBe(false);
    expect(AssetInput.safeParse({ name: 'n'.repeat(201), description: 'd' }).success).toBe(false);
    expect(AssetInput.safeParse({ name: 'n'.repeat(200), description: 'd' }).success).toBe(true);
    expect(AssetInput.safeParse({ name: 'n', description: ' ' }).success).toBe(false);
    expect(AssetInput.safeParse({ name: 'n', description: 'd'.repeat(DESCRIPTION_MAX_LENGTH + 1) }).success).toBe(false);
    expect(AssetInput.safeParse({ name: 'n', description: 'd'.repeat(DESCRIPTION_MAX_LENGTH) }).success).toBe(true);
  });

  it('counts a name in code points, as the database does', () => {
    expect(AssetInput.safeParse({ name: '😀'.repeat(200), description: 'd' }).success).toBe(true);
    expect(AssetInput.safeParse({ name: '😀'.repeat(201), description: 'd' }).success).toBe(false);
  });

  it('takes holder ids that are UUIDs, without a repeat, at most 1,000', () => {
    const base = { name: 'n', description: 'd' };
    const id = randomUUID();
    expect(AssetInput.safeParse({ ...base, holder_ids: ['not-a-uuid'] }).success).toBe(false);
    expect(AssetInput.safeParse({ ...base, holder_ids: [id, id] }).success).toBe(false);
    expect(AssetInput.safeParse({ ...base, holder_ids: Array.from({ length: 1001 }, () => randomUUID()) }).success).toBe(false);
    expect(AssetInput.safeParse({ ...base, holder_ids: Array.from({ length: 1000 }, () => randomUUID()) }).success).toBe(true);
  });
});

describe('AssetUpdate', () => {
  it('takes any of the three fields, and holder_ids replaces the set', () => {
    expect(AssetUpdate.parse({ name: 'New' })).toEqual({ name: 'New' });
    expect(AssetUpdate.parse({ holder_ids: [] })).toEqual({ holder_ids: [] });
  });

  it('refuses an empty body and an unknown key', () => {
    expect(AssetUpdate.safeParse({}).success).toBe(false);
    expect(AssetUpdate.safeParse({ name: 'n', provenance: null }).success).toBe(false);
  });
});

describe('AssetRecord', () => {
  const record = { id: randomUUID(), threat_model_id: randomUUID(), name: 'Tokens', description: 'd', holder_ids: [], created_at: now, updated_at: now };

  it('has exactly the fields of the data model', () => {
    expect(AssetRecord.parse(record)).toEqual(record);
    expect(AssetRecord.safeParse({ ...record, provenance: null }).success).toBe(false);
    expect(AssetRecord.safeParse({ ...record, holder_ids: undefined }).success).toBe(false);
  });
});

describe('assumptions', () => {
  it('take a statement of 1 to 10,000 characters, trimmed, and nothing else', () => {
    expect(AssumptionInput.parse({ statement: '  The database is not exposed. ' })).toEqual({ statement: 'The database is not exposed.' });
    expect(AssumptionInput.safeParse({ statement: ' ' }).success).toBe(false);
    expect(AssumptionInput.safeParse({ statement: 's'.repeat(DESCRIPTION_MAX_LENGTH + 1) }).success).toBe(false);
    expect(AssumptionInput.safeParse({ statement: 's', provenance: {} }).success).toBe(false);
    expect(AssumptionInput.safeParse({ statement: 's', threat_model_id: randomUUID() }).success).toBe(false);
  });

  it('are updated by a statement only, and not by an empty body', () => {
    expect(AssumptionUpdate.parse({ statement: 'New' })).toEqual({ statement: 'New' });
    expect(AssumptionUpdate.safeParse({}).success).toBe(false);
    expect(AssumptionUpdate.safeParse({ statement: 's', extra: 1 }).success).toBe(false);
  });

  it('are records with exactly the fields of the data model', () => {
    const record = { id: randomUUID(), threat_model_id: randomUUID(), statement: 'The database is not exposed.', created_at: now, updated_at: now };
    expect(AssumptionRecord.parse(record)).toEqual(record);
    expect(AssumptionRecord.safeParse({ ...record, rationale: 'x' }).success).toBe(false);
  });
});
