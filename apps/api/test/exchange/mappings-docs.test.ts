import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  IGNORED_PRESENTATION,
  NOT_IMPORTED_FIELDS,
  OTM_COMPONENT_TYPES,
  OTM_EXPORT,
  OTM_MITIGATION_STATES,
  OTM_THREAT_STATES,
  TD_FLAG_PAIRS,
  TD_SEVERITIES,
  TD_SHAPES,
  TD_STATUSES,
  TD_TAGS,
} from '@scrylux/core';
import { describe, expect, it } from 'vitest';

// docs/formats/otm.md and threat-dragon.md print the tables of packages/core/src/exchange/mappings.ts (research #21), and
// this keeps the two equal: a word added to the data and not to its document fails here.

const doc = (name: string): string => readFileSync(fileURLToPath(new URL(`../../../../docs/formats/${name}`, import.meta.url)), 'utf8');
const otm = doc('otm.md');
const threatDragon = doc('threat-dragon.md');

// Every string (and number, as written) a table holds as a value.
function leaves(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(leaves);
  return [];
}
const missingFrom = (text: string, table: unknown): string[] => [...new Set(leaves(table))].filter((word) => !text.includes(word));

describe('docs/formats/otm.md', () => {
  it.each([
    ['the component types', OTM_COMPONENT_TYPES],
    ['the threat states', OTM_THREAT_STATES],
    ['the mitigation states', OTM_MITIGATION_STATES],
    ['the export constants', OTM_EXPORT],
    ['the entries ignored without a note', IGNORED_PRESENTATION.otm],
  ])('prints %s', (_label, table) => {
    expect(missingFrom(otm, table)).toEqual([]);
  });
});

describe('docs/formats/threat-dragon.md', () => {
  it.each([
    ['the cell shapes', TD_SHAPES],
    ['the statuses', TD_STATUSES],
    ['the severities', TD_SEVERITIES],
    ['the flag pairs', TD_FLAG_PAIRS],
    ['the tags', TD_TAGS],
    ['the entries ignored without a note', IGNORED_PRESENTATION.threatDragon],
  ])('prints %s', (_label, table) => {
    expect(missingFrom(threatDragon, table)).toEqual([]);
  });
});

describe('the fields an import lists', () => {
  it('are each named in a format document', () => {
    const both = `${otm}\n${threatDragon}`;
    expect(NOT_IMPORTED_FIELDS.filter((field) => !both.includes(field))).toEqual([]);
  });
});
