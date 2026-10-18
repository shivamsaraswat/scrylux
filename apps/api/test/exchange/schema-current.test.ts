import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scryluxFileSchema } from '../../src/exchange/schema.js';
import { buildScryluxFile } from '../../src/exchange/scrylux-export.js';
import { ajv2020 } from './ajv.js';
import { hostile, snapshotOf, us1Model } from './fixtures.js';

// The published schema of the Scrylux file (FR-003a): the committed copy is current, and what the export writes
// validates against it.

const committed = (): unknown => JSON.parse(readFileSync(fileURLToPath(new URL('../../../../docs/formats/scrylux-file-v1.schema.json', import.meta.url)), 'utf8')) as unknown;

const validator = () => ajv2020().compile(committed() as object);

describe('docs/formats/scrylux-file-v1.schema.json', () => {
  it('is what the code generates', () => {
    expect(
      committed(),
      'docs/formats/scrylux-file-v1.schema.json is out of date. Run: pnpm --filter @scrylux/api formats',
    ).toEqual(scryluxFileSchema());
  });

  it('is a JSON Schema 2020-12 document with an id and a title', () => {
    const schema = committed() as Record<string, unknown>;
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(schema.$id).toBe('scrylux-file-v1.schema.json');
    expect(schema.title).toBe('Scrylux file, format version 1');
  });

  it('accepts the files the export writes (SC-001)', () => {
    const validate = validator();
    for (const file of [us1Model(), hostile()]) {
      const exported = buildScryluxFile(snapshotOf(file), new Date('2026-10-10T09:30:00.000Z'));
      const ok = validate(exported);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('refuses a file with a key missing, an unknown key, a wrong version or a bad enum value', () => {
    const validate = validator();
    const good = buildScryluxFile(snapshotOf(us1Model()), new Date('2026-10-10T09:30:00.000Z'));
    const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(good)) as Record<string, unknown>;

    const missing = clone();
    delete missing.threats;
    expect(validate(missing)).toBe(false);

    const extra = clone();
    extra.extra = 1;
    expect(validate(extra)).toBe(false);

    const version = clone();
    version.format_version = 2;
    expect(validate(version)).toBe(false);

    const status = clone();
    (status.threats as { status: string }[])[0]!.status = 'done';
    expect(validate(status)).toBe(false);
  });
});
