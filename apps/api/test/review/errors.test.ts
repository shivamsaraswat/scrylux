import { describe, expect, it } from 'vitest';
import { mapStorageError } from '../../src/v1/errors.js';

// The fixed messages of the new records' rules (Phase 3 Milestone 5, research #13): each constraint of migration 019 answers with
// text that holds no name, statement or row value, keyed on SQLSTATE and constraint name only.

const violation = (code: string, constraint: string) => Object.assign(new Error('Key (lower(btrim(name)))=(secret tokens) already exists'), { code, constraint, detail: 'secret tokens' });

describe('mapStorageError, the records of Milestone 5', () => {
  const cases: Array<[string, string, string, number, string]> = [
    ['23505', 'assets_name_key', 'write', 409, 'An asset with this name already exists'],
    ['23505', 'assumptions_statement_key', 'write', 409, 'This assumption already exists'],
    ['23514', 'assets_limit', 'write', 400, 'A threat model can hold at most 200 assets'],
    ['23514', 'assumptions_limit', 'write', 400, 'A threat model can hold at most 200 assumptions'],
    ['23514', 'asset_holders_node', 'write', 400, 'A holder must be a process, a data store or an external entity'],
    ['23503', 'asset_holders_element_fkey', 'write', 400, 'holder_ids must refer to elements in the same threat model'],
  ];

  for (const [code, constraint, operation, status, message] of cases) {
    it(`answers ${constraint} with ${status} and a fixed message`, () => {
      const mapped = mapStorageError(violation(code, constraint), operation as 'write');
      expect(mapped?.status).toBe(status);
      expect(mapped?.message).toBe(message);
    });
  }

  it('never repeats a row value from the driver', () => {
    for (const [code, constraint] of cases) {
      expect(mapStorageError(violation(code, constraint), 'write')?.message).not.toContain('secret');
    }
  });
});
