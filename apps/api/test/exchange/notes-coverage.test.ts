import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IGNORED_PRESENTATION, NOT_IMPORTED_FIELDS, NOTE_KINDS, OtmFile, TD_STATUSES, ThreatDragonFile, type ImportNote } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { planOtm } from '../../src/exchange/import/otm.js';
import { planThreatDragon } from '../../src/exchange/import/threat-dragon.js';

// The notes of an import (FR-016, data-model.md "Note kinds"): every kind has a producer, every path and detail is built
// from known keys and fixed lists, and what is presentation data is never noted.

type Obj = Record<string, unknown>;
const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const load = (path: string): Obj => JSON.parse(readFileSync(`${fixtures}${path}`, 'utf8')) as Obj;

// A file from another tool that makes every adapting rule of the OTM mapping act.
const kitchenSink = (): Obj => ({
  otmVersion: '0.2.0',
  project: { name: 'Sink', id: 'sink' },
  representations: [{ name: 'Diagram', id: 'diagram', type: 'diagram' }],
  trustZones: [
    { id: 'z1', name: 'Tiny', risk: { trustRating: 50 }, representations: [{ representation: 'diagram', id: 'a', position: { x: 1, y: 2 }, size: { width: 5, height: 5 } }] },
  ],
  components: [
    { id: 'outer', name: 'Outer', type: 'process', parent: { trustZone: 'z1' } },
    { id: 'inner', name: 'x'.repeat(250), type: 'process', parent: { component: 'outer' }, tags: ['A', 'a'], representations: [{ representation: 'diagram', id: 'b', position: { x: 900000, y: 1 } }] },
  ],
  dataflows: [],
  threats: [{ id: 't1', name: 'Odd', categories: ['Spoofing'], risk: { likelihood: 500, impact: 50 } }],
  mitigations: [],
});
const withStatus = (): Obj => ({
  ...kitchenSink(),
  components: [{ id: 'outer', name: 'Outer', type: 'process', parent: { trustZone: 'z1' }, threats: [{ threat: 't1', state: 'strange' }] }],
});

const notes = (): ImportNote[] => {
  const result: ImportNote[] = [];
  for (const file of [load('otm/EXAMPLE.json'), kitchenSink(), withStatus()]) result.push(...planOtm(OtmFile.parse(file)).notes);
  for (const name of readdirSync(`${fixtures}threat-dragon`)) result.push(...planThreatDragon(ThreatDragonFile.parse(load(`threat-dragon/${name}`))).notes);
  return result;
};

const IGNORED = new Set<string>([...IGNORED_PRESENTATION.otm, ...IGNORED_PRESENTATION.threatDragon]);
const DETAILS: Record<string, (detail: string | undefined) => boolean> = {
  'not_imported.field': (detail) => (NOT_IMPORTED_FIELDS as readonly string[]).includes(detail ?? ''),
  'mapped.component_type': (detail) => detail === 'process',
  'mapped.status': (detail) => detail === 'other' || (TD_STATUSES.unmapped as readonly string[]).includes((detail ?? '').toLowerCase()),
  'mapped.severity': (detail) => detail === 'null' || detail === 'TBA' || detail === 'other',
  'adjusted.shortened': (detail) => detail === 'name' || detail === 'description' || detail === 'mitigation',
  'adjusted.layout': (detail) => detail === 'unplaced' || detail === 'enlarged',
};

describe('the notes of an import', () => {
  it('has a producer for every kind', () => {
    const produced = new Set(notes().map((item) => item.kind));
    expect([...NOTE_KINDS].filter((kind) => !produced.has(kind))).toEqual([]);
  });

  it('builds every path from known keys and indexes only', () => {
    for (const item of notes()) expect(item.path).toMatch(/^file(\.([a-zA-Z_]+|\d+))*$/);
  });

  it('takes every detail from the fixed list of its kind, and gives none to a kind with none', () => {
    for (const item of notes()) {
      const check = DETAILS[item.kind];
      if (check === undefined) expect(item.detail, item.kind).toBeUndefined();
      else expect(check(item.detail), `${item.kind}: ${String(item.detail)}`).toBe(true);
    }
  });

  it('never notes what is presentation data or an identifier (FR-016)', () => {
    for (const item of notes()) {
      expect(IGNORED.has(item.path.split('.').at(-1) ?? ''), item.path).toBe(false);
      expect(IGNORED.has(item.detail ?? ''), `${item.kind}: ${String(item.detail)}`).toBe(false);
    }
  });
});
