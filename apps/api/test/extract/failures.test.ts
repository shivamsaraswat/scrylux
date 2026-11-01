import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { extractDocument, type ExtractLimits, type ExtractResult } from '../../src/extract/run.js';
import { pdf } from '../fixtures/sources/pdf.js';
import { docx, zip } from '../fixtures/sources/zip.js';

// What goes wrong with a file, through the real extraction child (Phase 3 Milestone 3, US5, FR-011, FR-012, SC-004, research #3
// to #5): each file that cannot be read fails with a category of its own, within the bounds, and nothing the file points at is
// ever fetched. A page without text is not a failure of the child (the worker decides on `no_text_found`, ingest-failures.test.ts).

const LIMITS: ExtractLimits = { maxPages: 2000, unpackedBytes: 50 * 1024 * 1024, memoryMb: 1024, timeLimitMs: 60_000 };
const run = (type: 'pdf' | 'docx', bytes: Uint8Array, limits: Partial<ExtractLimits> = {}, entry?: string): Promise<ExtractResult> =>
  extractDocument({ type, bytes, limits: { ...LIMITS, ...limits }, ...(entry === undefined ? {} : { entry: new URL(`./children/${entry}.ts`, import.meta.url) }) });
const failed = async (...args: Parameters<typeof run>) => {
  const result = await run(...args);
  if (result.ok) throw new Error('expected a failure');
  return result;
};

describe('a PDF that cannot be read', () => {
  it('is refused as encrypted when it needs a password, and the password is never asked for', async () => {
    expect(await failed('pdf', pdf({ pages: ['secret'], userPassword: 'hunter2' }))).toEqual({ ok: false, category: 'encrypted' });
  });

  it('gives no blocks, and counts every page as without text, when no page has text', async () => {
    const result = await run('pdf', pdf({ pages: [null, null] }));
    expect(result).toEqual({ ok: true, blocks: [], pagesWithoutText: 2 });
  });

  it('is too large, by pages, past EXTRACT_MAX_PAGES, and 2,000 pages are read', async () => {
    expect(await failed('pdf', pdf({ pages: Array.from({ length: 2001 }, () => 'x') }))).toEqual({ ok: false, category: 'too_large', detail: 'pages' });
    const exactly = await run('pdf', pdf({ pages: Array.from({ length: 40 }, () => 'x') }), { maxPages: 40 });
    expect(exactly.ok).toBe(true);
    expect(await failed('pdf', pdf({ pages: Array.from({ length: 41 }, () => 'x') }), { maxPages: 40 })).toMatchObject({ category: 'too_large', detail: 'pages' });
  }, 60_000);

  it('is damaged when its bytes are cut short or are not a PDF at all', async () => {
    const whole = pdf({ pages: ['some text', 'more text'] });
    expect(await failed('pdf', whole.subarray(0, 120))).toMatchObject({ category: 'damaged' });
    expect(await failed('pdf', Buffer.from('%PDF-1.4\nthis is not a document'))).toMatchObject({ category: 'damaged' });
    expect(await failed('pdf', Buffer.alloc(0))).toMatchObject({ category: 'damaged' });
  });
});

describe('a Word file that cannot be read', () => {
  it('is unsupported when it is macro-enabled (.docm)', async () => {
    expect(await failed('docx', docx({ blocks: [{ paragraph: 'text' }], macro: true }))).toEqual({ ok: false, category: 'unsupported_type' });
  });

  it('is damaged when it has no main part, or is not an archive', async () => {
    expect(await failed('docx', docx({ blocks: [{ paragraph: 'text' }], withoutMain: true }))).toMatchObject({ category: 'damaged' });
    expect(await failed('docx', Buffer.from('PK\u0003\u0004 and then nothing a ZIP reader could use'))).toMatchObject({ category: 'damaged' });
    expect(await failed('docx', docx({ blocks: [{ paragraph: 'text' }] }).subarray(0, 100))).toMatchObject({ category: 'damaged' });
  });

  it('is damaged when a part holds a document type declaration, which Word never writes', async () => {
    expect(await failed('docx', docx({ blocks: [{ paragraph: 'text' }], doctype: true }))).toMatchObject({ category: 'damaged' });
  });

  it('is too large unpacked when a part is really larger than the size its header declares', async () => {
    // The main part itself lies: a header that says 100 bytes, with a megabyte of XML under it.
    const big = `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${'<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(30_000)}</w:body></w:document>`;
    const archive = zip([
      { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
      { name: 'word/document.xml', data: big, method: 'deflate', declaredSize: 100 },
    ]);
    const result = await run('docx', archive, { unpackedBytes: 1024 * 1024 });
    // Either the archive reader notices the lie (damaged) or the bound does; in no case is the part read as the size it claimed.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(['damaged', 'too_large_unpacked']).toContain(result.category);
  });

  it('is too large unpacked when the parts it reads declare more than EXTRACT_UNPACKED_MB together', async () => {
    const heavy = docx({ blocks: [{ paragraph: 'text' }], extra: [{ name: 'word/styles.xml', data: `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${' '.repeat(2 * 1024 * 1024)}</w:styles>`, method: 'deflate' }] });
    expect(heavy.length).toBeLessThan(200 * 1024);
    expect(await failed('docx', heavy, { unpackedBytes: 1024 * 1024 })).toEqual({ ok: false, category: 'too_large_unpacked' });
  });

  it('does not unpack what it never reads: a huge entry that is not one of the three parts costs nothing', async () => {
    const withMedia = docx({ blocks: [{ paragraph: 'kept' }], extra: [{ name: 'word/media/image1.bin', data: Buffer.alloc(8 * 1024 * 1024, 7), method: 'deflate' }] });
    const result = await run('docx', withMedia, { unpackedBytes: 1024 * 1024 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.blocks.map((b) => b.text)).toEqual(['kept']);
  });
});

describe('a child that does not come back with an answer (FR-011, SC-004)', () => {
  const never = pdf({ pages: ['x'] });

  it('is stopped when the time passes, and the file is unreadable by time', async () => {
    const started = Date.now();
    expect(await failed('pdf', never, { timeLimitMs: 800 }, 'loop')).toEqual({ ok: false, category: 'unreadable', detail: 'time' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('exits when it passes its memory check, and the file is unreadable by memory (exit 3)', async () => {
    expect(await failed('pdf', never, { memoryMb: 256 }, 'grow')).toEqual({ ok: false, category: 'unreadable', detail: 'memory' });
  }, 60_000);

  it('is unreadable by memory when it exhausts its heap before any check (SIGABRT)', async () => {
    expect(await failed('pdf', never, { memoryMb: 128 }, 'heap')).toEqual({ ok: false, category: 'unreadable', detail: 'memory' });
  }, 60_000);

  it('is unreadable by memory when it is killed from outside (SIGKILL), as the kernel does', async () => {
    expect(await failed('pdf', never, {}, 'killed')).toEqual({ ok: false, category: 'unreadable', detail: 'memory' });
  });

  it('is damaged when it leaves without an answer for any other reason', async () => {
    expect(await failed('pdf', never, {}, 'crash')).toEqual({ ok: false, category: 'damaged' });
  });

  it('leaves the worker able to read the next file, even while several of these run at once', async () => {
    const [a, b, ok] = await Promise.all([
      run('pdf', never, { timeLimitMs: 500 }, 'loop'),
      run('pdf', never, { memoryMb: 128 }, 'heap'),
      run('pdf', pdf({ pages: ['still fine'] })),
    ]);
    expect(a).toMatchObject({ ok: false, detail: 'time' });
    expect(b).toMatchObject({ ok: false, detail: 'memory' });
    expect(ok).toMatchObject({ ok: true, blocks: [{ text: 'still fine', page: 1 }] });
  }, 60_000);
});

describe('nothing the file points at is fetched (FR-012)', () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200).end('x');
  });
  const listening = new Promise<string>((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/trap`)));
  afterEach(() => {
    requests.length = 0;
  });

  it('a PDF with a JavaScript open action, a link and a font at an address still gives its text, and the server is never asked', async () => {
    const url = await listening;
    const result = await run('pdf', pdf({ pages: ['visible text'], externalUrl: url }));
    expect(result).toMatchObject({ ok: true, blocks: [{ text: 'visible text', page: 1 }] });
    // Give a late request time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests).toEqual([]);
  });

  it('a Word file with an external image and an external hyperlink still gives its text, and the server is never asked', async () => {
    const url = await listening;
    const result = await run('docx', docx({ blocks: [{ paragraph: 'visible text' }], externalUrl: url }));
    // The text of the hyperlink is read like any other text; where it points is not followed.
    expect(result.ok && result.blocks.map((b) => b.text)).toEqual(['visible text', 'link']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(requests).toEqual([]);
    server.close();
  });
});
