import { describe, expect, it } from 'vitest';
import { codePointLength, decodeUtf8, markdownHeadings, normalizeText } from '../../src/sources/text.js';

// Text is normalized once, before it is measured or chunked (Phase 3 Milestone 3, FR-021, FR-022, research #6). Every
// length and offset counts code points, which is what Postgres's char_length counts, so that a chunk's offsets and its
// stored text agree. A line number counted in the normalized text is the line number of the text as received.

describe('codePointLength', () => {
  it('counts a character outside the basic plane once, not as two UTF-16 units', () => {
    expect('a\u{1F600}b'.length).toBe(4);
    expect(codePointLength('a\u{1F600}b')).toBe(3);
    expect(codePointLength('')).toBe(0);
    expect(codePointLength('Zürich 日本語')).toBe(10);
  });
});

describe('decodeUtf8', () => {
  it('decodes UTF-8 and removes a leading byte-order mark', () => {
    expect(decodeUtf8(Buffer.from('Zürich \u{1F600}'))).toBe('Zürich \u{1F600}');
    expect(decodeUtf8(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('marked')]))).toBe('marked');
  });

  it('keeps a byte-order mark that is not first, which is a character like any other', () => {
    expect(decodeUtf8(Buffer.from('a﻿b'))).toBe('a﻿b');
  });

  it('refuses bytes that are not UTF-8 rather than guessing an encoding', () => {
    expect(() => decodeUtf8(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toThrow(TypeError);
    expect(() => decodeUtf8(Buffer.from([0xc0, 0xaf]))).toThrow(TypeError);
  });
});

describe('normalizeText', () => {
  it('writes every line break (CRLF, CR, LF) as exactly one LF, so line numbers do not drift on a Windows file', () => {
    const received = 'one\r\ntwo\rthree\nfour\r\n\r\nsix';
    const normalized = normalizeText(received);
    expect(normalized).toBe('one\ntwo\nthree\nfour\n\nsix');
    expect(normalized.split('\n')).toHaveLength(received.split(/\r\n|\r|\n/).length);
  });

  it('treats CR LF as one break and a lone CR before an LF-less end as one break', () => {
    expect(normalizeText('a\r\nb')).toBe('a\nb');
    expect(normalizeText('a\r\rb')).toBe('a\n\nb');
    expect(normalizeText('end\r')).toBe('end\n');
  });

  it('removes NUL characters, which a text layer can hold and Postgres text refuses', () => {
    expect(normalizeText('a\u0000b\u0000')).toBe('ab');
  });

  it('replaces a lone surrogate with U+FFFD, so that the text stored is the text measured', () => {
    expect(normalizeText('a\ud800b')).toBe('a�b');
    expect(normalizeText('a\udc00')).toBe('a�');
    expect(normalizeText('pair \u{1F600} stays')).toBe('pair \u{1F600} stays');
    expect(codePointLength(normalizeText('a\ud800b'))).toBe(3);
  });

  it('leaves everything else as it is: spaces, tabs, form feeds, accents', () => {
    expect(normalizeText('  indented\ttab \f page é')).toBe('  indented\ttab \f page é');
  });

  it('is its own fixed point', () => {
    const once = normalizeText('x\r\ny\u0000\ud800z');
    expect(normalizeText(once)).toBe(once);
  });
});

describe('markdownHeadings', () => {
  const offsetOf = (text: string, needle: string): number => codePointLength(text.slice(0, text.indexOf(needle)));

  it('finds ATX headings of every level, with the offset of the line they start', () => {
    const text = '# One\ntext\n## Two\n###### Six\n####### seven hashes is not a heading\n';
    expect(markdownHeadings(text)).toEqual([
      { offset: 0, text: 'One' },
      { offset: offsetOf(text, '## Two'), text: 'Two' },
      { offset: offsetOf(text, '###### Six'), text: 'Six' },
    ]);
  });

  it('strips the closing hashes and the spaces around a heading, and allows up to three spaces of indent', () => {
    expect(markdownHeadings('  ##   Spaced out   ##  \n')).toEqual([{ offset: 0, text: 'Spaced out' }]);
    expect(markdownHeadings('    # four spaces is code\n')).toEqual([]);
    expect(markdownHeadings('#nospace\n')).toEqual([]);
  });

  it('finds setext headings: a line of text underlined with = or --', () => {
    const text = 'Title\n=====\n\nSection\n-------\n\nbody\n';
    expect(markdownHeadings(text)).toEqual([
      { offset: 0, text: 'Title' },
      { offset: offsetOf(text, 'Section'), text: 'Section' },
    ]);
  });

  it('does not take a horizontal rule or a list marker for an underline', () => {
    expect(markdownHeadings('para\n\n---\n\nmore\n')).toEqual([]);
    expect(markdownHeadings('para\n-\nnext\n')).toEqual([]);
  });

  it('ignores anything inside a fenced code block, whichever fence opens it', () => {
    const text = '# Real\n```\n# not a heading\nTitle\n=====\n```\n~~~\n## nor this\n~~~\n## After\n';
    expect(markdownHeadings(text).map((h) => h.text)).toEqual(['Real', 'After']);
  });

  it('closes a fence only with the same kind of fence, and treats an unclosed one as running to the end', () => {
    expect(markdownHeadings('```\n~~~\n# still code\n```\n# out\n').map((h) => h.text)).toEqual(['out']);
    expect(markdownHeadings('# a\n```\n# inside until the end\n').map((h) => h.text)).toEqual(['a']);
  });

  it('counts offsets in code points, not UTF-16 units', () => {
    const text = '\u{1F600}\u{1F600}\n# After emoji\n';
    expect(markdownHeadings(text)).toEqual([{ offset: 3, text: 'After emoji' }]);
  });

  it('keeps a heading to 200 characters', () => {
    const long = 'h'.repeat(250);
    const [heading] = markdownHeadings(`# ${long}\n`);
    expect(heading?.text).toHaveLength(200);
  });

  it('skips an empty heading', () => {
    expect(markdownHeadings('#\n##   \n# real\n').map((h) => h.text)).toEqual(['real']);
  });

  it('returns nothing for text without headings, and for an empty text', () => {
    expect(markdownHeadings('just a paragraph\nand another\n')).toEqual([]);
    expect(markdownHeadings('')).toEqual([]);
  });

  it('reads text that has already been normalized to LF, as the chunker gives it', () => {
    expect(markdownHeadings(normalizeText('# A\r\ntext\r\n## B\r\n')).map((h) => h.text)).toEqual(['A', 'B']);
  });
});
