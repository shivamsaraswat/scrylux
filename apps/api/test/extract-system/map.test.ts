import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mapAnswer } from '../../src/extract-system/map.js';
import type { LabelledChunk } from '../../src/extract-system/content.js';
import { CHUNK_TEXTS, validAnswer } from '../fixtures/extract-system/answers.js';

// Turning a validated answer into the rows of a draft (Phase 3 Milestone 4, research #3, #4; data-model.md): references become the ids of the
// new items, labels become the ids of the chunks that were sent, and a quote becomes the span of its chunk, never a copy of its text.

const labelled: LabelledChunk[] = Object.entries(CHUNK_TEXTS).map(([label, text]) => ({ label, text, chunkId: randomUUID() }));
const chunkIdOf = (label: string): string => labelled.find((c) => c.label === label)?.chunkId as string;

describe('items', () => {
  const mapped = mapAnswer(validAnswer(), labelled);

  it('numbers the items in the order of the answer: elements, then assets, then assumptions', () => {
    expect(mapped.items.map((i) => i.position)).toEqual(mapped.items.map((_, index) => index));
    expect(mapped.items.map((i) => i.kind)).toEqual([
      'trust_boundary',
      'trust_boundary',
      'external_entity',
      'process',
      'process',
      'data_store',
      'external_entity',
      'data_flow',
      'data_flow',
      'asset',
      'assumption',
    ]);
  });

  it('gives each item an id of its own and keeps none of the model’s references', () => {
    const ids = mapped.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(mapped)).not.toContain('private_net');
    expect(JSON.stringify(mapped)).not.toContain('worker_provider');
  });

  it('turns a reference into the id of the item it names: a boundary, and the two ends of a flow', () => {
    const byName = (name: string) => mapped.items.find((i) => i.name === name)!;
    expect(byName('API').boundaryId).toBe(byName('Internet').id);
    expect(byName('Database').boundaryId).toBe(byName('Private network').id);
    expect(byName('Internet').boundaryId).toBeNull();
    const flow = byName('Threat data');
    expect(flow.kind).toBe('data_flow');
    expect(flow.sourceItemId).toBe(byName('API').id);
    expect(flow.targetItemId).toBe(byName('Database').id);
    expect(byName('API').sourceItemId).toBeNull();
  });

  it('keeps an element’s name, an asset’s name and description, and an assumption’s statement and no name', () => {
    const asset = mapped.items.find((i) => i.kind === 'asset')!;
    expect(asset).toMatchObject({ name: 'Threat data', body: 'The threats the application stores.' });
    const assumption = mapped.items.find((i) => i.kind === 'assumption')!;
    expect(assumption).toMatchObject({ name: null, body: 'The database is reachable only from the API and the worker.' });
    expect(mapped.items.find((i) => i.name === 'API')!.body).toBeNull();
  });

  it('keeps the flags of an element as an object of values, and gives the others none', () => {
    expect(mapped.items.find((i) => i.name === 'API')!.flags).toEqual({ internet_facing: true });
    expect(mapped.items.find((i) => i.name === 'Database')!.flags).toEqual({ internet_facing: false });
    expect(mapped.items.find((i) => i.name === 'Internet')!.flags).toEqual({});
    expect(mapped.items.find((i) => i.kind === 'asset')!.flags).toEqual({});
  });

  it('keeps each rationale', () => {
    expect(mapped.items.find((i) => i.name === 'Database')!.rationale).toBe('Threats are kept in a PostgreSQL database.');
  });
});

describe('asset holders', () => {
  it('names the elements that hold an asset by their ids', () => {
    const mapped = mapAnswer(validAnswer(), labelled);
    const asset = mapped.items.find((i) => i.kind === 'asset')!;
    const db = mapped.items.find((i) => i.name === 'Database')!;
    expect(mapped.holders).toEqual([{ assetId: asset.id, elementId: db.id }]);
  });
});

describe('citations', () => {
  const mapped = mapAnswer(validAnswer(), labelled);

  it('points each at the chunk that was sent under its label, never at an identifier the model wrote', () => {
    const api = mapped.items.find((i) => i.name === 'API')!;
    const own = mapped.citations.filter((c) => c.itemId === api.id && c.flag === null);
    expect(own.map((c) => c.chunkId)).toEqual([chunkIdOf('c1'), chunkIdOf('c2')]);
  });

  it('numbers an item’s citations from 0, and each flag’s from 0 apart from them', () => {
    const api = mapped.items.find((i) => i.name === 'API')!;
    expect(mapped.citations.filter((c) => c.itemId === api.id && c.flag === null).map((c) => c.position)).toEqual([0, 1]);
    expect(mapped.citations.filter((c) => c.itemId === api.id && c.flag === 'internet_facing').map((c) => c.position)).toEqual([0]);
  });

  it('stores a quote as its span in its chunk, in code points, and never its text', () => {
    for (const citation of mapped.citations) {
      const text = [...(labelled.find((c) => c.chunkId === citation.chunkId)?.text ?? '')];
      expect(citation.quoteEnd).toBeGreaterThan(citation.quoteStart);
      expect(citation.quoteEnd - citation.quoteStart).toBeGreaterThanOrEqual(12);
      expect(citation.quoteEnd).toBeLessThanOrEqual(text.length);
      expect(Object.keys(citation).sort()).toEqual(['chunkId', 'flag', 'itemId', 'position', 'quoteEnd', 'quoteStart']);
    }
    const api = mapped.items.find((i) => i.name === 'API')!;
    const first = mapped.citations.find((c) => c.itemId === api.id && c.flag === null)!;
    expect([...CHUNK_TEXTS.c1].slice(first.quoteStart, first.quoteEnd).join('')).toBe('served by the API');
  });

  it('gives the span of a quote that differs from its chunk only in whitespace in the chunk’s own text', () => {
    const answer = validAnswer();
    answer.elements[2]!.citations[0]!.quote = 'Users sign   in with a username and a password. The API';
    const once = mapAnswer(answer, labelled);
    const user = once.items.find((i) => i.name === 'User')!;
    const cited = once.citations.find((c) => c.itemId === user.id && c.flag === null)!;
    expect([...CHUNK_TEXTS.c1].slice(cited.quoteStart, cited.quoteEnd).join('')).toBe('Users sign in with a username and a password.\nThe API');
  });

  it('counts every citation of the answer: elements, their flags, assets and assumptions', () => {
    const answer = validAnswer();
    const expected =
      answer.elements.reduce((n, e) => n + e.citations.length + e.flags.reduce((m, f) => m + f.citations.length, 0), 0) +
      answer.assets.reduce((n, a) => n + a.citations.length, 0) +
      answer.assumptions.reduce((n, a) => n + a.citations.length, 0);
    expect(mapped.citations).toHaveLength(expected);
  });
});

describe('an answer that the checks should have refused', () => {
  it('throws rather than store a citation to a label that was not sent', () => {
    const answer = validAnswer();
    answer.elements[0]!.citations[0]!.chunk = 'c9';
    expect(() => mapAnswer(answer, labelled)).toThrow(/label/);
  });

  it('throws rather than store a quote that is not in its chunk', () => {
    const answer = validAnswer();
    answer.elements[0]!.citations[0]!.quote = 'a passage that is nowhere at all';
    expect(() => mapAnswer(answer, labelled)).toThrow(/quote/);
  });

  it('throws rather than store a reference that names no item', () => {
    const answer = validAnswer();
    answer.elements[3]!.boundary = 'nowhere';
    expect(() => mapAnswer(answer, labelled)).toThrow(/reference/);
  });

  it('never puts the answer’s text in the error', () => {
    const answer = validAnswer();
    answer.elements[0]!.citations[0]!.quote = 'CANARY passage that is nowhere at all';
    try {
      mapAnswer(answer, labelled);
    } catch (error) {
      expect((error as Error).message).not.toContain('CANARY');
    }
  });
});

describe('an empty answer', () => {
  it('maps to no row', () => {
    expect(mapAnswer({ elements: [], assets: [], assumptions: [], nothing_found: 'Nothing.' }, labelled)).toEqual({ items: [], holders: [], citations: [] });
  });
});
