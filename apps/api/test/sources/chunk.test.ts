import { describe, expect, it } from 'vitest';
import { CHUNK_MAX_CHARS } from '@scrylux/core';
import { chunkDocument, type ChunkDraft, type DocumentModel } from '../../src/sources/chunk.js';
import { codePointLength } from '../../src/sources/text.js';

// The chunker (Phase 3 Milestone 3, FR-020 to FR-022, research #7): consecutive slices of the extracted text, none longer
// than 2,000 code points, with no gap and no overlap, so that reading them in order gives the text back exactly. A cut
// prefers a page break, then a heading, a blank line, a line end, a sentence end and a space, in that order, among the cuts
// that leave a chunk of 1,000 to 2,000 code points; only a run with none is cut where the limit falls.

const words = (count: number, start = 0): string => Array.from({ length: count }, (_, i) => `word${start + i}`).join(' ');
/** `n` code points of words, ending on a space so that the next text starts a new word. */
const filler = (n: number): string => `${'word '.repeat(Math.ceil(n / 5))}`.slice(0, n);
const model = (text: string, extra: Partial<DocumentModel> = {}): DocumentModel => ({ text, lines: false, ...extra });

const joined = (chunks: ChunkDraft[]): string => chunks.map((c) => c.text).join('');
const lengths = (chunks: ChunkDraft[]): number[] => chunks.map((c) => c.endOffset - c.startOffset);

function expectWellFormed(text: string, chunks: ChunkDraft[]): void {
  const points = Array.from(text);
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks[0]?.startOffset).toBe(0);
  expect(chunks.at(-1)?.endOffset).toBe(points.length);
  chunks.forEach((chunk, i) => {
    expect(chunk.position, 'position').toBe(i);
    if (i > 0) expect(chunk.startOffset, `chunk ${i} starts where ${i - 1} ends`).toBe(chunks[i - 1]?.endOffset);
    expect(chunk.endOffset - chunk.startOffset, `chunk ${i} length`).toBeLessThanOrEqual(CHUNK_MAX_CHARS);
    expect(chunk.endOffset, 'end after start').toBeGreaterThan(chunk.startOffset);
    expect(chunk.text, `chunk ${i} text is its slice`).toBe(points.slice(chunk.startOffset, chunk.endOffset).join(''));
    expect(codePointLength(chunk.text)).toBe(chunk.endOffset - chunk.startOffset);
  });
  expect(joined(chunks)).toBe(text);
}

describe('the limit and the reconstruction', () => {
  it('gives no chunk for a text with nothing in it but whitespace', () => {
    expect(chunkDocument(model(''))).toEqual([]);
    expect(chunkDocument(model('   \n\n\t  \n'))).toEqual([]);
  });

  it('keeps a short text whole, with its trailing whitespace', () => {
    const [only, ...rest] = chunkDocument(model('A short note.\n\n'));
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ position: 0, startOffset: 0, endOffset: 15, text: 'A short note.\n\n' });
  });

  it('keeps a text of exactly 2,000 code points whole, and cuts one of 2,001 in two', () => {
    expect(chunkDocument(model('x'.repeat(2000)))).toHaveLength(1);
    const two = chunkDocument(model('x'.repeat(2001)));
    expect(two).toHaveLength(2);
    expect(lengths(two)).toEqual([2000, 1]);
  });

  it.each([
    ['plain prose', words(2500)],
    ['paragraphs', Array.from({ length: 60 }, (_, i) => words(70, i * 70)).join('\n\n')],
    ['lines', Array.from({ length: 400 }, (_, i) => `line ${i}: ${words(9, i)}`).join('\n')],
    ['sentences', Array.from({ length: 300 }, (_, i) => `This is sentence number ${i} of the design.`).join(' ')],
    ['text with accents and emoji', Array.from({ length: 500 }, (_, i) => `Zürich \u{1F600} 日本語 ${i}`).join(' ')],
  ])('covers %s with consecutive chunks that give the text back exactly', (_label, text) => {
    const chunks = chunkDocument(model(text));
    expectWellFormed(text, chunks);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('covers a text of the largest default size, in a reasonable time', () => {
    const text = Array.from({ length: 25000 }, (_, i) => `Paragraph ${i}: the gateway forwards each request.`).join('\n\n').slice(0, 1_000_000);
    expect(text).toHaveLength(1_000_000);
    const started = Date.now();
    const chunks = chunkDocument(model(text));
    expect(Date.now() - started).toBeLessThan(5000);
    expectWellFormed(text, chunks);
    // At least a million over 2,000, and at most a million over the 1,000 that a cut leaves, plus the last.
    expect(chunks.length).toBeGreaterThanOrEqual(500);
    expect(chunks.length).toBeLessThanOrEqual(1001);
  });

  it('gives the same chunks for the same text', () => {
    const text = words(2000);
    expect(chunkDocument(model(text))).toEqual(chunkDocument(model(text)));
  });
});

describe('where a cut falls', () => {
  it('cuts a run with no boundary where the limit falls: 5,000 characters make 2,000, 2,000 and 1,000', () => {
    const chunks = chunkDocument(model('x'.repeat(5000)));
    expect(lengths(chunks)).toEqual([2000, 2000, 1000]);
  });

  it('prefers a page break to every other boundary in the window', () => {
    const page1 = filler(1200);
    const page2 = `${filler(500)}\n\n${filler(1500)}`;
    const text = page1 + page2;
    const chunks = chunkDocument(model(text, { pageStarts: [0, 1200] }));
    expect(chunks[0]?.endOffset).toBe(1200);
    expectWellFormed(text, chunks);
  });

  it('prefers the start of a heading to a blank line', () => {
    const text = `${filler(1100)}## Section\n${filler(400)}\n\n${filler(1500)}`;
    const chunks = chunkDocument(model(text, { headings: [{ offset: 1100, text: 'Section' }] }));
    expect(chunks[0]?.endOffset).toBe(1100);
  });

  it('prefers a blank line to a line end', () => {
    // A line end every 100 characters, and one blank line among them, which ends at offset 1,300, inside the window.
    const lines = Array.from({ length: 30 }, () => `${'y'.repeat(99)}\n`);
    lines[12] = `${'y'.repeat(98)}\n\n`;
    const text = lines.join('');
    const expected = text.indexOf('\n\n') + 2;
    expect(expected).toBeGreaterThanOrEqual(1000);
    expect(expected).toBeLessThanOrEqual(2000);
    expect(chunkDocument(model(text))[0]?.endOffset).toBe(expected);
  });

  it('puts a blank line, however many line breaks it has, wholly in the chunk before the cut', () => {
    const text = `${'z'.repeat(1300)}\n\n\n\n${'z'.repeat(1500)}`;
    const [first, second] = chunkDocument(model(text));
    expect(first?.text.endsWith('\n\n\n\n')).toBe(true);
    expect(second?.text.startsWith('z')).toBe(true);
  });

  it('prefers a line end to a sentence end', () => {
    const text = `${'a'.repeat(1390)}\n${'b'.repeat(300)}. ${'c'.repeat(1000)}`;
    expect(chunkDocument(model(text))[0]?.endOffset).toBe(1391);
  });

  it('prefers a sentence end to a space, and starts the next chunk at a word', () => {
    const text = `${filler(1195)}end. ${filler(1000)}`;
    const [first, second] = chunkDocument(model(text));
    expect(first?.text.endsWith('end. ')).toBe(true);
    expect(second?.text.startsWith('word')).toBe(true);
  });

  it('recognises a sentence end after a closing quote or bracket, and for ! and ?', () => {
    for (const ending of ['end!" ', 'end?) ', "end.' "]) {
      const text = `${filler(1195)}${ending}${filler(1000)}`;
      expect(chunkDocument(model(text))[0]?.text.endsWith(ending), ending).toBe(true);
    }
  });

  it('falls back to a space, cutting after it, so that no word is split', () => {
    const text = words(900);
    const chunks = chunkDocument(model(text));
    for (const chunk of chunks.slice(0, -1)) expect(chunk.text.endsWith(' ')).toBe(true);
  });

  it('prefers a boundary in the window of 1,000 to 2,000 over a better one earlier', () => {
    // A blank line at 300, and nothing but spaces after it: the cut is the last space, not the blank line.
    const text = `${'a'.repeat(298)}\n\n${filler(3000)}`;
    const [first] = chunkDocument(model(text));
    expect(first?.endOffset).toBeGreaterThan(1900);
  });

  it('looks before the window when there is nothing in it: a blank line at 300 and one 3,000-character word', () => {
    const text = `${'a'.repeat(298)}\n\n${'w'.repeat(3000)}`;
    expect(chunkDocument(model(text))[0]?.endOffset).toBe(300);
  });

  it('leaves no remainder of whitespace alone: the cut is before the last character that is not a space', () => {
    const text = `${'w'.repeat(1995)}${' '.repeat(10)}`;
    const chunks = chunkDocument(model(text));
    expectWellFormed(text, chunks);
    for (const chunk of chunks) expect(chunk.text.trim().length).toBeGreaterThan(0);
  });

  it('gives whitespace between paragraphs to the chunk before, so none is only whitespace', () => {
    const text = Array.from({ length: 80 }, (_, i) => `${filler(400)} ${i}`).join('\n\n     \n\n');
    const chunks = chunkDocument(model(text));
    expectWellFormed(text, chunks);
    for (const chunk of chunks) expect(chunk.text.trim().length).toBeGreaterThan(0);
  });

  it('still covers the text, contiguously and within the limit, across a run of 5,000 spaces', () => {
    const text = `${filler(900)}${' '.repeat(5000)}${filler(900)}`;
    expectWellFormed(text, chunkDocument(model(text)));
  });

  it('never cuts inside a character that is two UTF-16 units', () => {
    const text = `${'a'.repeat(1999)}\u{1F600}${'b'.repeat(500)}`;
    const chunks = chunkDocument(model(text));
    expectWellFormed(text, chunks);
    expect(chunks[0]?.endOffset).toBe(2000);
    expect(chunks[0]?.text.endsWith('\u{1F600}')).toBe(true);
    // A lone surrogate would show as a code unit with no partner.
    for (const chunk of chunks) expect(chunk.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});

describe('where a chunk came from', () => {
  it('names the pages a chunk spans, and none for a text without pages', () => {
    const pageText = (n: number): string => `${filler(900)}p${n}\n`;
    const text = [1, 2, 3, 4, 5].map(pageText).join('');
    const pageStarts: number[] = [];
    let at = 0;
    for (const n of [1, 2, 3, 4, 5]) {
      pageStarts.push(at);
      at += codePointLength(pageText(n));
    }
    const chunks = chunkDocument(model(text, { pageStarts }));
    expectWellFormed(text, chunks);
    for (const chunk of chunks) {
      const pageOf = (offset: number): number => pageStarts.filter((s) => s <= offset).length;
      expect(chunk.pageFirst).toBe(pageOf(chunk.startOffset));
      expect(chunk.pageLast).toBe(pageOf(chunk.endOffset - 1));
      expect(chunk.lineFirst).toBeNull();
      expect(chunk.lineLast).toBeNull();
    }
    expect(chunkDocument(model(text))[0]?.pageFirst).toBeNull();
  });

  it('puts a chunk that ends where a page starts wholly on the page before', () => {
    const page1 = filler(1200);
    const text = page1 + filler(1500);
    const [first, second] = chunkDocument(model(text, { pageStarts: [0, 1200] }));
    expect(first).toMatchObject({ pageFirst: 1, pageLast: 1 });
    expect(second?.pageFirst).toBe(2);
  });

  it('skips a page that has no text: the page that holds a character is the last one that starts at or before it', () => {
    const text = filler(500) + filler(500);
    const chunks = chunkDocument(model(text, { pageStarts: [0, 500, 500, 500] }));
    expect(chunks[0]).toMatchObject({ pageFirst: 1, pageLast: 4 });
  });

  it('numbers the lines of a text file, counting line breaks before the chunk', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${filler(20)}`);
    const text = lines.join('\n');
    const chunks = chunkDocument(model(text, { lines: true }));
    expectWellFormed(text, chunks);
    const points = Array.from(text);
    for (const chunk of chunks) {
      const lineOf = (index: number): number => points.slice(0, index).filter((c) => c === '\n').length + 1;
      expect(chunk.lineFirst, 'first line').toBe(lineOf(chunk.startOffset));
      expect(chunk.lineLast, 'last line').toBe(lineOf(chunk.endOffset - 1));
      expect(chunk.pageFirst).toBeNull();
    }
    expect(chunks[0]?.lineFirst).toBe(1);
    expect(chunks.at(-1)?.lineLast).toBe(300);
  });

  it('gives a chunk that ends with a line break the line that the break ends', () => {
    const text = `${'a'.repeat(1390)}\n${'b'.repeat(1000)}`;
    const [first, second] = chunkDocument(model(text, { lines: true }));
    expect(first).toMatchObject({ lineFirst: 1, lineLast: 1 });
    expect(second).toMatchObject({ lineFirst: 2, lineLast: 2 });
  });

  it('counts lines in the text as received: CRLF normalized to LF gives the same line numbers', () => {
    const received = Array.from({ length: 200 }, (_, i) => `line ${i + 1} ${filler(30)}`).join('\r\n');
    const normalized = received.replace(/\r\n/g, '\n');
    const chunks = chunkDocument(model(normalized, { lines: true }));
    expect(chunks.at(-1)?.lineLast).toBe(received.split('\r\n').length);
  });

  it('records the nearest heading at or before the chunk’s start, and none before the first heading', () => {
    const text = `${filler(1000)}\n# Gateway\n${filler(1000)}\n## Storage\n${filler(2500)}`;
    const gateway = text.indexOf('# Gateway');
    const storage = text.indexOf('## Storage');
    const headings = [
      { offset: gateway, text: 'Gateway' },
      { offset: storage, text: 'Storage' },
    ];
    const chunks = chunkDocument(model(text, { lines: true, headings }));
    expectWellFormed(text, chunks);
    for (const chunk of chunks) {
      const nearest = [...headings].reverse().find((h) => h.offset <= chunk.startOffset);
      expect(chunk.heading, `chunk at ${chunk.startOffset}`).toBe(nearest?.text ?? null);
    }
    expect(chunks[0]?.heading).toBeNull();
    expect(chunks.some((c) => c.heading === 'Storage')).toBe(true);
  });

  it('gives a chunk that starts exactly at a heading that heading', () => {
    const text = `${filler(1100)}## Section\n${filler(1800)}`;
    const chunks = chunkDocument(model(text, { headings: [{ offset: 1100, text: 'Section' }] }));
    expect(chunks[1]).toMatchObject({ startOffset: 1100, heading: 'Section' });
  });

  it('keeps a heading to 200 characters', () => {
    const chunks = chunkDocument(model(filler(300), { headings: [{ offset: 0, text: 'h'.repeat(300) }] }));
    expect(chunks[0]?.heading).toHaveLength(200);
  });

  it('records none of pages, lines or heading unless the document has them', () => {
    const [chunk] = chunkDocument(model('plain text'));
    expect(chunk).toMatchObject({ pageFirst: null, pageLast: null, lineFirst: null, lineLast: null, heading: null });
  });
});
