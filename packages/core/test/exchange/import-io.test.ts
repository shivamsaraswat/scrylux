import { describe, expect, it } from 'vitest';
import * as mappings from '../../src/exchange/mappings.js';
import {
  EXPORT_FORMATS,
  IMPORT_FORMATS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_DEPTH,
  IMPORT_MAX_VALUES,
  NAME_ISSUES,
  NOTE_KINDS,
  SCRYLUX_FORMAT_VERSION,
  ExportQuery,
  ImportInput,
  ImportResult,
  ImportSummary,
  nameIssues,
} from '../../src/index.js';

// The shared vocabulary and the request and response schemas of the import and export operations (data-model.md,
// "Shared vocabulary" and "Import request and response").

describe('the shared vocabulary', () => {
  it('fixes the limits and the format version', () => {
    expect(IMPORT_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(IMPORT_MAX_DEPTH).toBe(64);
    expect(IMPORT_MAX_VALUES).toBe(2_000_000);
    expect(SCRYLUX_FORMAT_VERSION).toBe(1);
  });

  it('lists the formats and name issues', () => {
    expect([...EXPORT_FORMATS]).toEqual(['scrylux', 'otm']);
    expect([...IMPORT_FORMATS]).toEqual(['scrylux', 'otm', 'threat-dragon']);
    expect([...NAME_ISSUES]).toEqual(['empty', 'too_long', 'duplicate', 'taken']);
  });

  it('lists the 17 note kinds of the data model', () => {
    expect(NOTE_KINDS).toHaveLength(17);
    expect(new Set(NOTE_KINDS).size).toBe(17);
  });
});

describe('ExportQuery', () => {
  it('accepts each export format', () => {
    for (const format of EXPORT_FORMATS) expect(ExportQuery.parse({ format })).toEqual({ format });
  });

  it.each([
    ['nothing', {}],
    ['an unknown format', { format: 'xml' }],
    ['an empty format', { format: '' }],
    ['a repeated parameter (an array)', { format: ['scrylux', 'scrylux'] }],
    ['a format that is only imported', { format: 'threat-dragon' }],
    ['a non-string', { format: 1 }],
    ['an extra key', { format: 'scrylux', extra: '1' }],
  ])('refuses %s with the one message, never echoing the value', (_label, query) => {
    const result = ExportQuery.safeParse(query);
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toEqual([`format must be ${EXPORT_FORMATS.join(' or ')}`]);
  });
});

describe('ImportInput', () => {
  const file = { format: 'scrylux' };

  it('accepts a format, optional names and a file object', () => {
    expect(ImportInput.parse({ format: 'scrylux', file })).toEqual({ format: 'scrylux', file });
    expect(ImportInput.parse({ format: 'scrylux', names: ['A', ' '], file }).names).toEqual(['A', ' ']);
  });

  it('does not trim or check names: a name issue is reported, never refused here', () => {
    expect(ImportInput.safeParse({ format: 'scrylux', names: ['', 'x'.repeat(500)], file }).success).toBe(true);
  });

  it('does not walk into the file', () => {
    let deep: unknown[] = [];
    for (let level = 0; level < 10_000; level += 1) deep = [deep];
    const parsed = ImportInput.parse({ format: 'scrylux', file: { deep } });
    expect(parsed.file.deep).toBe(deep);
  });

  it.each([
    ['an array', []],
    ['a string', 'text'],
    ['null', null],
    ['a number', 1],
  ])('refuses %s as the file', (_label, bad) => {
    expect(ImportInput.safeParse({ format: 'scrylux', file: bad }).success).toBe(false);
  });

  it('refuses an unknown format, a missing file and unknown top-level keys', () => {
    expect(ImportInput.safeParse({ format: 'xml', file }).success).toBe(false);
    expect(ImportInput.safeParse({ format: 'scrylux' }).success).toBe(false);
    expect(ImportInput.safeParse({ format: 'scrylux', file, extra: 1 }).success).toBe(false);
  });
});

describe('ImportSummary and ImportResult', () => {
  const model = { name: 'M', name_issue: null, status: 'draft', elements: 1, threats: 2, mitigations: 3 };

  it('accepts models and notes of the fixed shape', () => {
    const summary = {
      models: [model, { ...model, name_issue: 'taken' }],
      notes: [{ path: 'file.x', kind: NOTE_KINDS[0], label: 'L', detail: 'd' }, { path: 'file.y', kind: NOTE_KINDS[1] }],
    };
    expect(ImportSummary.parse(summary)).toEqual(summary);
  });

  it('refuses an unknown name issue, status or note kind, and extra keys', () => {
    expect(ImportSummary.safeParse({ models: [{ ...model, name_issue: 'bad' }], notes: [] }).success).toBe(false);
    expect(ImportSummary.safeParse({ models: [{ ...model, status: 'bad' }], notes: [] }).success).toBe(false);
    expect(ImportSummary.safeParse({ models: [], notes: [{ path: 'p', kind: 'unknown.kind' }] }).success).toBe(false);
    expect(ImportSummary.safeParse({ models: [{ ...model, extra: 1 }], notes: [] }).success).toBe(false);
  });

  it('wraps created threat models and the summary in a result', () => {
    const record = {
      id: '00000000-0000-4000-8000-000000000001',
      project_id: '00000000-0000-4000-8000-000000000002',
      name: 'M',
      methodology: 'STRIDE',
      status: 'draft',
      created_at: '2026-10-10T00:00:00.000Z',
      updated_at: '2026-10-10T00:00:00.000Z',
    };
    const result = { threat_models: [record], summary: { models: [model], notes: [] } };
    expect(ImportResult.parse(result)).toEqual(result);
    expect(ImportResult.safeParse({ threat_models: [], summary: { models: [], notes: [] }, extra: 1 }).success).toBe(false);
  });
});

describe('nameIssues', () => {
  it('flags a name already in the project, comparing like lower(btrim(name))', () => {
    expect(nameIssues(['  Checkout '], ['checkout'])).toEqual(['taken']);
  });

  it('flags both of two equal names in one file as duplicates', () => {
    expect(nameIssues(['A', 'a ', 'B'], [])).toEqual(['duplicate', 'duplicate', null]);
  });

  it('flags an empty name and a name over 200 code points, counting an emoji once', () => {
    expect(nameIssues(['   '], [])).toEqual(['empty']);
    expect(nameIssues(['x'.repeat(201)], [])).toEqual(['too_long']);
    expect(nameIssues(['x'.repeat(200)], [])).toEqual([null]);
    expect(nameIssues(['😀'.repeat(200)], [])).toEqual([null]);
    expect(nameIssues(['😀'.repeat(201)], [])).toEqual(['too_long']);
  });

  it('gives null for a usable name, keeps the order, and never throws', () => {
    expect(nameIssues(['One', 'Two', ''], ['Three'])).toEqual([null, null, 'empty']);
    expect(nameIssues([], ['x'])).toEqual([]);
  });
});

describe('mappings.ts is data only (research #21)', () => {
  it('exports exactly the tables the planners read', () => {
    expect(Object.keys(mappings).sort()).toEqual(
      [
        'IGNORED_PRESENTATION',
        'NOT_IMPORTED_FIELDS',
        'OTM_COMPONENT_TYPES',
        'OTM_EXPORT',
        'OTM_MITIGATION_STATES',
        'OTM_THREAT_STATES',
        'TD_FLAG_PAIRS',
        'TD_SEVERITIES',
        'TD_SHAPES',
        'TD_STATUSES',
        'TD_TAGS',
      ].sort(),
    );
  });

  it('holds no function anywhere, and survives a JSON round trip unchanged', () => {
    const walk = (value: unknown): void => {
      expect(typeof value).not.toBe('function');
      if (typeof value === 'object' && value !== null) for (const inner of Object.values(value)) walk(inner);
    };
    for (const table of Object.values(mappings)) {
      walk(table);
      expect(JSON.parse(JSON.stringify(table))).toEqual(table);
    }
  });
});
