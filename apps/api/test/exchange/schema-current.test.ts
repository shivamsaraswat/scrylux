import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { scryluxFileSchema } from '../../src/exchange/schema.js';
import { buildScryluxFile } from '../../src/exchange/scrylux-export.js';
import { ajv2020 } from './ajv.js';
import { hostile, snapshotOf, us1Model, us1ModelV2 } from './fixtures.js';

// The published schemas of the Scrylux file (FR-003a): the committed copies are current, and what the export writes validates against them. Version 1 is
// the file of Phase 2, still read and still published; version 2 adds the two lists of Phase 3 Milestone 5 (FR-023), and is what an export writes.

const committed = (version: 1 | 2): unknown =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../docs/formats/scrylux-file-v${version}.schema.json`, import.meta.url)), 'utf8')) as unknown;

const validator = (version: 1 | 2) => ajv2020().compile(committed(version) as object);

for (const version of [1, 2] as const) {
  describe(`docs/formats/scrylux-file-v${version}.schema.json`, () => {
    it('is what the code generates', () => {
      expect(committed(version), `docs/formats/scrylux-file-v${version}.schema.json is out of date. Run: pnpm --filter @scrylux/api formats`).toEqual(scryluxFileSchema(version));
    });

    it('is a JSON Schema 2020-12 document with an id and a title', () => {
      const schema = committed(version) as Record<string, unknown>;
      expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.$id).toBe(`scrylux-file-v${version}.schema.json`);
      expect(schema.title).toBe(`Scrylux file, format version ${version}`);
    });
  });
}

describe('the version 1 schema', () => {
  it('accepts a version 1 file, and refuses the lists of version 2', () => {
    const validate = validator(1);
    expect(validate(us1Model()), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(us1ModelV2())).toBe(false);
  });
});

describe('the version 2 schema', () => {
  it('accepts the files the export writes (SC-001)', () => {
    const validate = validator(2);
    for (const file of [us1Model(), us1ModelV2(), hostile()]) {
      const exported = buildScryluxFile(snapshotOf(file), new Date('2026-10-10T09:30:00.000Z'));
      const ok = validate(exported);
      expect(ok, JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it('refuses a file with a key missing, an unknown key, a wrong version or a bad enum value', () => {
    const validate = validator(2);
    const good = buildScryluxFile(snapshotOf(us1ModelV2()), new Date('2026-10-10T09:30:00.000Z'));
    const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(good)) as Record<string, unknown>;

    for (const key of ['threats', 'assets', 'assumptions']) {
      const missing = clone();
      delete missing[key];
      expect(validate(missing), key).toBe(false);
    }

    const extra = clone();
    extra.extra = 1;
    expect(validate(extra)).toBe(false);

    const version = clone();
    version.format_version = 1;
    expect(validate(version)).toBe(false);

    const status = clone();
    (status.threats as { status: string }[])[0]!.status = 'done';
    expect(validate(status)).toBe(false);
  });

  it('refuses a key an asset or an assumption is not allowed to have, such as provenance', () => {
    const validate = validator(2);
    const file = JSON.parse(JSON.stringify(buildScryluxFile(snapshotOf(us1ModelV2()), new Date('2026-10-10T09:30:00.000Z')))) as { assets: Record<string, unknown>[]; assumptions: Record<string, unknown>[] };
    file.assets[0]!.provenance = {};
    expect(validate(file)).toBe(false);
    delete file.assets[0]!.provenance;
    file.assumptions[0]!.rationale = 'x';
    expect(validate(file)).toBe(false);
  });
});
