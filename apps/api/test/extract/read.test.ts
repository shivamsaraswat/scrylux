import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractDocument, type ExtractLimits, type ExtractResult } from '../../src/extract/run.js';
import { pdf } from '../fixtures/sources/pdf.js';
import { docx } from '../fixtures/sources/zip.js';

// Reading a PDF or a Word file, through the real extraction child (Phase 3 Milestone 3, FR-010, FR-012, FR-014, research
// #3 to #5). The child answers with blocks in reading order: one per page of a PDF that has text, and one per paragraph or
// table of a Word file, with its headings marked. The worker joins them, normalizes the text and chunks it. What goes wrong
// with a file, and the bounds, are in failures.test.ts.

const LIMITS: ExtractLimits = { maxPages: 2000, unpackedBytes: 50 * 1024 * 1024, memoryMb: 512, timeLimitMs: 60_000 };
const run = (type: 'pdf' | 'docx', bytes: Uint8Array, limits: Partial<ExtractLimits> = {}): Promise<ExtractResult> =>
  extractDocument({ type, bytes, limits: { ...LIMITS, ...limits } });

async function read(type: 'pdf' | 'docx', bytes: Uint8Array) {
  const result = await run(type, bytes);
  if (!result.ok) throw new Error(`expected the file to be read, got ${result.category}`);
  return result;
}

describe('a PDF', () => {
  it('gives one block per page that has text, with its page number, and counts the pages that have none', async () => {
    const result = await read('pdf', pdf({ pages: ['Hello world\nsecond line', null, 'third page'] }));
    expect(result.blocks).toEqual([
      { text: 'Hello world\nsecond line', page: 1 },
      { text: 'third page', page: 3 },
    ]);
    expect(result.pagesWithoutText).toBe(1);
  });

  it('counts none when every page has text', async () => {
    const result = await read('pdf', pdf({ pages: ['one', 'two', 'three'] }));
    expect(result.pagesWithoutText).toBe(0);
    expect(result.blocks.map((b) => b.page)).toEqual([1, 2, 3]);
  });

  it('reads the pages in order, however many', async () => {
    const pages = Array.from({ length: 40 }, (_, i) => `Page ${i + 1} describes component ${i + 1}.`);
    const result = await read('pdf', pdf({ pages }));
    expect(result.blocks.map((b) => b.text)).toEqual(pages);
    expect(result.blocks.map((b) => b.page)).toEqual(pages.map((_, i) => i + 1));
  });

  it('keeps a character that the text layer gives as U+0000, which the worker removes when it normalizes', async () => {
    const result = await read('pdf', pdf({ pages: ['a\u0000b'], nul: true }));
    expect(result.blocks).toEqual([{ text: 'a\u0000b', page: 1 }]);
  });

  it('gives no text block for a file whose pages only draw, and counts every page as without text', async () => {
    const result = await read('pdf', pdf({ pages: [null, null, null] }));
    expect(result.blocks).toEqual([]);
    expect(result.pagesWithoutText).toBe(3);
  });

  it('does not write what a parsing library prints into the worker’s output, and leaves the blocks to the answer', async () => {
    const result = await read('pdf', pdf({ pages: ['text'] }));
    expect(JSON.stringify(result)).not.toMatch(/Warning|polyfill|napi/i);
  });
});

describe('a Word file', () => {
  const file = docx({
    blocks: [
      { paragraph: 'Introduction', style: 'Heading1' },
      { paragraph: 'The gateway forwards each request.' },
      { table: [['Component', 'Owner'], ['Gateway', 'Platform']] },
      { paragraph: 'first line\nsecond line', lineBreak: true },
      { paragraph: 'Storage', style: 'Heading2' },
      { paragraph: 'Rows are kept in Postgres.' },
    ],
  });

  it('gives one block per paragraph or table, in reading order, with the headings marked', async () => {
    const result = await read('docx', file);
    expect(result.blocks).toEqual([
      { text: 'Introduction', isHeading: true },
      { text: 'The gateway forwards each request.' },
      { text: 'Component\tOwner\nGateway\tPlatform' },
      { text: 'first line\nsecond line' },
      { text: 'Storage', isHeading: true },
      { text: 'Rows are kept in Postgres.' },
    ]);
    expect(result.pagesWithoutText).toBeNull();
  });

  it('keeps the text of table cells in order, a tab between cells and a line break between rows (FR-014)', async () => {
    const result = await read('docx', docx({ blocks: [{ table: [['a', 'b', 'c'], ['d', 'e', 'f']] }] }));
    expect(result.blocks).toEqual([{ text: 'a\tb\tc\nd\te\tf' }]);
  });

  it('recognises a Title and a heading by the style’s name in styles.xml, not by its id', async () => {
    const result = await read('docx', docx({ blocks: [{ paragraph: 'The Design', style: 'Title' }, { paragraph: 'body' }] }));
    expect(result.blocks[0]).toEqual({ text: 'The Design', isHeading: true });
    expect(result.blocks[1]).toEqual({ text: 'body' });
  });

  it('leaves out paragraphs with nothing in them', async () => {
    const result = await read('docx', docx({ blocks: [{ paragraph: 'before' }, { paragraph: '   ' }, { paragraph: '' }, { paragraph: 'after' }] }));
    expect(result.blocks.map((b) => b.text)).toEqual(['before', 'after']);
  });

  it('decodes the characters XML escapes, and keeps text that XML needs escaped', async () => {
    const result = await read('docx', docx({ blocks: [{ paragraph: 'Tom & Jerry <script>alert(1)</script> "quoted"' }] }));
    expect(result.blocks).toEqual([{ text: 'Tom & Jerry <script>alert(1)</script> "quoted"' }]);
  });

  it('reads a file stored without compression as it reads one that is deflated', async () => {
    const blocks = [{ paragraph: 'same text either way' }];
    expect((await read('docx', docx({ blocks, method: 'store' }))).blocks).toEqual((await read('docx', docx({ blocks, method: 'deflate' }))).blocks);
  });
});

describe('the child that reads the file', () => {
  it('is given no environment, so a flaw in a parser finds no credential (research #3)', async () => {
    // The test process holds a database password and a provider key, as the worker does.
    const saved = { DB_PASSWORD: process.env.DB_PASSWORD, LLM_API_KEY: process.env.LLM_API_KEY };
    process.env.DB_PASSWORD = 'a-password-for-this-test';
    process.env.LLM_API_KEY = 'a-key-for-this-test';
    try {
      const result = await extractDocument({
        type: 'pdf',
        bytes: Buffer.from('%PDF-1.4'),
        limits: LIMITS,
        entry: new URL('./children/env.ts', import.meta.url),
      });
      expect(result.ok).toBe(true);
      const names = result.ok ? (JSON.parse(result.blocks[0]?.text ?? '[]') as string[]) : ['the child did not answer'];
      // macOS adds __CF_USER_TEXT_ENCODING, a character-encoding hint, to every process it starts with an empty environment.
      // It is the system's, not the parent's, and holds nothing; nothing of the parent's arrives.
      expect(names.filter((name) => name !== '__CF_USER_TEXT_ENCODING')).toEqual([]);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('prints nothing into its parent’s output or error, whatever the library it runs prints', () => {
    const script = fileURLToPath(new URL('./children/run-noisy.ts', import.meta.url));
    const run = spawnSync(process.execPath, ['--import', 'tsx', '--conditions=@scrylux/source', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.stdout).toContain('RESULT ok');
    expect(`${run.stdout}${run.stderr}`).not.toContain('CANARY');
  }, 60_000);
});
