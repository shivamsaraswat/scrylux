import { readdirSync, readFileSync } from 'node:fs';
import { DraftAnswer, ELEMENT_FLAGS, ELEMENT_TYPES } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PROMPT_FILES, loadExtractionPrompt, parseQueries, promptVersion } from '../../src/extract-system/prompt.js';

// The prompt files of an extraction and the version every draft records (Phase 3 Milestone 4, research #12, contracts/data-files.md).
// The instructions and the retrieval queries are versioned data in the repository (Principle IV), and the version is a hash of
// them and of the answer's schema, so a change to any of them changes it without anyone remembering to bump a number.

const DIR = new URL('../../prompts/extract-system/', import.meta.url);

describe('the shipped files', () => {
  it('load: the instructions, the queries and a version', () => {
    const prompt = loadExtractionPrompt();
    expect(prompt.instructions.length).toBeGreaterThan(500);
    expect(prompt.queries.length).toBe(8);
    expect(prompt.version).toMatch(/^extract-system\/[0-9a-f]{12}$/);
  });

  it('are read once and are the same on every load', () => {
    expect(loadExtractionPrompt()).toBe(loadExtractionPrompt());
  });

  it('are exactly the files that the version hashes: a new file in the directory fails here until it is hashed too', () => {
    expect(readdirSync(DIR).sort()).toEqual([...PROMPT_FILES].sort());
  });

  it('keep the instructions to the size that research #5 budgets for them', () => {
    expect(loadExtractionPrompt().instructions.length).toBeLessThanOrEqual(6000);
  });

  it('hold no placeholder that a source could fill: the content goes only through the marked section (FR-036)', () => {
    const text = readFileSync(new URL('instructions.md', DIR), 'utf8');
    expect(text).not.toContain('{{');
    expect(text).not.toContain('}}');
  });

  it('tell the model that the content is data, that it has no tool, and how to cite and quote', () => {
    const text = loadExtractionPrompt().instructions;
    expect(text).toMatch(/never instructions/i);
    expect(text).toMatch(/no tools/i);
    expect(text).toMatch(/12 to 200 characters/);
    expect(text).toContain('nothing_found');
    expect(text).toMatch(/leave the flag out/i);
  });

  it('name the flags each element type allows, exactly as ELEMENT_FLAGS does', () => {
    const text = loadExtractionPrompt().instructions;
    for (const type of ELEMENT_TYPES.filter((t) => t !== 'data_flow' || ELEMENT_FLAGS.data_flow.length > 0)) {
      const flags = ELEMENT_FLAGS[type];
      const line = `- ${type}: ${flags.length === 0 ? 'none' : flags.join(', ')}`;
      expect(text, line).toContain(line);
    }
  });

  it('state the limits that the answer schema enforces', () => {
    const text = loadExtractionPrompt().instructions;
    expect(text).toContain('40 elements');
    expect(text).toContain('15 assets');
    expect(text).toContain('15 assumptions');
  });
});

describe('parseQueries', () => {
  const good = ['components and services', 'data stores'];
  const file = (queries: unknown) => `queries:\n${(queries as string[]).map((q) => `  - ${q}`).join('\n')}\n`;

  it('reads 1 to 16 queries', () => {
    expect(parseQueries(file(good))).toEqual(good);
    expect(parseQueries(file(Array.from({ length: 16 }, (_, i) => `query ${i}`)))).toHaveLength(16);
  });

  it('refuses none, more than 16, an empty or over-long query, and anything that is not a list of strings', () => {
    expect(() => parseQueries('queries: []\n')).toThrow(/1 to 16/);
    expect(() => parseQueries(file(Array.from({ length: 17 }, (_, i) => `query ${i}`)))).toThrow(/1 to 16/);
    expect(() => parseQueries('queries:\n  - ""\n')).toThrow(/queries/);
    expect(() => parseQueries(`queries:\n  - ${'x'.repeat(301)}\n`)).toThrow(/queries/);
    expect(() => parseQueries(`queries:\n  - ${'x'.repeat(300)}\n`)).not.toThrow();
    expect(() => parseQueries('queries:\n  - 5\n')).toThrow(/queries/);
    expect(() => parseQueries('queries: nope\n')).toThrow(/queries/);
    expect(() => parseQueries('items:\n  - a\n')).toThrow();
    expect(() => parseQueries('queries:\n  - a\nextra: 1\n')).toThrow();
  });

  it('refuses YAML that is ambiguous: anchors, aliases, duplicate keys and several documents', () => {
    expect(() => parseQueries('queries:\n  - &a one\n  - *a\n')).toThrow();
    expect(() => parseQueries('queries:\n  - one\nqueries:\n  - two\n')).toThrow();
    expect(() => parseQueries('queries:\n  - one\n---\nqueries:\n  - two\n')).toThrow();
  });
});

describe('promptVersion', () => {
  const files = { instructions: 'Describe the system.\n', queries: 'queries:\n  - components\n' };
  const schema = '{"type":"object"}';

  it('is extract-system/ and twelve hex digits', () => {
    expect(promptVersion(files, schema)).toMatch(/^extract-system\/[0-9a-f]{12}$/);
  });

  it('is stable for the same files and schema', () => {
    expect(promptVersion({ ...files }, schema)).toBe(promptVersion({ ...files }, schema));
  });

  it('changes when the instructions, the queries or the schema change by one character', () => {
    const base = promptVersion(files, schema);
    expect(promptVersion({ ...files, instructions: files.instructions.replace('system', 'systems') }, schema)).not.toBe(base);
    expect(promptVersion({ ...files, queries: files.queries.replace('components', 'component') }, schema)).not.toBe(base);
    expect(promptVersion(files, '{"type":"object "}')).not.toBe(base);
  });

  it('cannot be fooled by moving text from one file to the next', () => {
    expect(promptVersion({ instructions: 'ab', queries: 'c' }, schema)).not.toBe(promptVersion({ instructions: 'a', queries: 'bc' }, schema));
    expect(promptVersion({ instructions: 'a', queries: 'b' }, 'c')).not.toBe(promptVersion({ instructions: 'a', queries: 'bc' }, ''));
  });

  it('follows the real answer schema: the shipped version is for the schema that is sent', () => {
    const { version } = loadExtractionPrompt();
    expect(version).toBe(
      promptVersion(
        {
          instructions: readFileSync(new URL('instructions.md', DIR), 'utf8'),
          queries: readFileSync(new URL('retrieval-queries.yaml', DIR), 'utf8'),
        },
        JSON.stringify(z.toJSONSchema(DraftAnswer, { target: 'draft-2020-12' })),
      ),
    );
  });
});
