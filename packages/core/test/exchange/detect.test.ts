import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { detectFormat } from '../../src/index.js';

// Which format a parsed file is in, from its content (research #13, #17). The API never sniffs; the web app does.

const fixtures = fileURLToPath(new URL('../../../../apps/api/test/exchange/fixtures/', import.meta.url));
const load = (path: string): unknown => JSON.parse(readFileSync(`${fixtures}${path}`, 'utf8')) as unknown;

describe('detectFormat', () => {
  it('recognises a Scrylux file by its format member', () => {
    expect(detectFormat({ format: 'scrylux', format_version: 1 })).toEqual({ format: 'scrylux' });
  });

  it('recognises an OTM file by a string otmVersion, whatever the version, so the API can name the one it refuses', () => {
    expect(detectFormat({ otmVersion: '0.2.0', project: {} })).toEqual({ format: 'otm' });
    expect(detectFormat({ otmVersion: '0.1.0' })).toEqual({ format: 'otm' });
  });

  it('recognises Threat Dragon version 2 by its version and its diagram cells', () => {
    expect(detectFormat({ version: '2.3.0', detail: { diagrams: [{ cells: [] }] } })).toEqual({ format: 'threat-dragon' });
  });

  it('names a Threat Dragon version 1 file, so the message can say how to convert it', () => {
    expect(detectFormat({ version: '1.0', detail: { diagrams: [{ diagramJson: {} }] } })).toEqual({
      format: null,
      reason: 'threat-dragon-v1',
    });
  });

  it.each([
    ['an empty object', {}],
    ['an array', []],
    ['a string', 'x'],
    ['null', null],
    ['a number', 1],
    ['a file with an unknown format', { format: 'other' }],
    ['a Threat Dragon version 3 file', { version: '3.0.0', detail: { diagrams: [{ cells: [] }] } }],
  ])('gives unknown for %s', (_label, value) => {
    expect(detectFormat(value)).toEqual({ format: null, reason: 'unknown' });
  });

  it('recognises every fixture', () => {
    expect(detectFormat(load('otm/EXAMPLE.json'))).toEqual({ format: 'otm' });
    expect(detectFormat(load('otm/mobile-cloud.otm.json'))).toEqual({ format: 'otm' });
    for (const name of readdirSync(`${fixtures}threat-dragon`)) {
      expect(detectFormat(load(`threat-dragon/${name}`))).toEqual({ format: 'threat-dragon' });
    }
  });
});
