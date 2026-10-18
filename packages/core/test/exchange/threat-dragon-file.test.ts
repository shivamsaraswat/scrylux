import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ThreatDragonFile } from '../../src/index.js';

// What Scrylux reads of a Threat Dragon version 2 file (contracts/threat-dragon-mapping.md, research #7): only the
// members the mapping uses, typed, every other member allowed and never walked.

const dir = fileURLToPath(new URL('../../../../apps/api/test/exchange/fixtures/threat-dragon/', import.meta.url));
const demo = (name: string): Record<string, unknown> => JSON.parse(readFileSync(`${dir}${name}`, 'utf8')) as Record<string, unknown>;

const minimal = () => ({
  version: '2.3.0',
  summary: { title: 'Model' },
  detail: {
    diagrams: [
      {
        title: 'Main',
        diagramType: 'STRIDE',
        cells: [
          { id: 'a', shape: 'actor', position: { x: 1, y: 2 }, size: { width: 60, height: 40 }, data: { name: 'User', threats: [{ title: 'T', status: 'Open', severity: 'High', type: 'Spoofing', mitigation: 'M' }] } },
          { id: 'f', shape: 'flow', source: { cell: 'a' }, target: { cell: 'a' }, data: { name: 'Loop', isEncrypted: true, protocol: 'HTTPS' } },
        ],
      },
    ],
  },
});

describe('ThreatDragonFile accepts', () => {
  it.each(readdirSync(dir))('the demo model %s', (name) => {
    expect(ThreatDragonFile.safeParse(demo(name)).success).toBe(true);
  });

  it('a minimal file', () => {
    expect(ThreatDragonFile.safeParse(minimal()).success).toBe(true);
  });

  it('members it does not read, at every level, and never walks into them', () => {
    let deep: unknown[] = [];
    for (let level = 0; level < 10_000; level += 1) deep = [deep];
    const file = minimal() as Record<string, unknown>;
    file.extra = deep;
    (((file.detail as { diagrams: { cells: Record<string, unknown>[] }[] }).diagrams[0] as { cells: Record<string, unknown>[] }).cells[0] as Record<string, unknown>).attrs = { deep };
    expect(ThreatDragonFile.safeParse(file).success).toBe(true);
  });

  it('a file with no summary, and cells with no data', () => {
    const file = minimal() as Record<string, unknown>;
    delete file.summary;
    (file.detail as { diagrams: { cells: unknown[] }[] }).diagrams[0]!.cells = [{ id: 'x', shape: 'td-text-block' }];
    expect(ThreatDragonFile.safeParse(file).success).toBe(true);
  });
});

describe('ThreatDragonFile refuses, naming the place', () => {
  type Cell = Record<string, unknown> & { data?: Record<string, unknown> & { threats?: Record<string, unknown>[] } };
  const refusal = (change: (cells: Cell[], file: { detail: { diagrams: { cells: unknown }[] } }) => void): string[] => {
    const file = minimal();
    change(file.detail.diagrams[0]?.cells as Cell[], file);
    const result = ThreatDragonFile.safeParse(file);
    expect(result.success).toBe(false);
    return result.error?.issues.map((issue) => issue.path.join('.')) ?? [];
  };

  it('a member it reads with the wrong type', () => {
    expect(refusal((_cells, file) => { file.detail.diagrams[0]!.cells = 'no'; })).toContain('detail.diagrams.0.cells');
    expect(refusal((cells) => { cells[0]!.position = { x: 'a', y: 1 }; })).toContain('detail.diagrams.0.cells.0.position.x');
    expect(refusal((cells) => { cells[0]!.data!.threats![0]!.title = 5; })).toContain('detail.diagrams.0.cells.0.data.threats.0.title');
    expect(refusal((cells) => { cells[1]!.data!.isEncrypted = 'yes'; })).toContain('detail.diagrams.0.cells.1.data.isEncrypted');
  });

  it('a file with no version or no diagrams', () => {
    expect(ThreatDragonFile.safeParse({ detail: { diagrams: [] } }).success).toBe(false);
    expect(ThreatDragonFile.safeParse({ version: '2.3.0' }).success).toBe(false);
  });

  it('a name over 10,000 characters, and a list of over 100,000 items', () => {
    expect(refusal((cells) => { cells[0]!.data!.name = 'x'.repeat(10_001); })).toContain('detail.diagrams.0.cells.0.data.name');
    const many = minimal() as { detail: { diagrams: { cells: unknown }[] } };
    many.detail.diagrams[0]!.cells = Array.from({ length: 100_001 }, (_unused, index) => ({ id: `c${index}`, shape: 'process' }));
    expect(ThreatDragonFile.safeParse(many).success).toBe(false);
  });
});
