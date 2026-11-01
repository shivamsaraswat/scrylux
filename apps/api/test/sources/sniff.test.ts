import { describe, expect, it } from 'vitest';
import { sniffPaste, sniffUpload } from '../../src/sources/sniff.js';
import { docx, zip } from '../fixtures/sources/zip.js';
import { pdf } from '../fixtures/sources/pdf.js';

// What the API checks of an upload before it stores anything (Phase 3 Milestone 3, FR-003): the file's type from its first
// bytes, which must agree with its extension, and for text that it is UTF-8. The API reads no more of a file's structure
// than that, because reading a structure is parsing, which only the worker does (FR-010).

const bytes = (...values: number[]): Buffer => Buffer.from(values);
const OLE = bytes(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0);
const EXECUTABLE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 0x90)]);
const ELF = Buffer.concat([bytes(0x7f), Buffer.from('ELF'), Buffer.alloc(200)]);

describe('a PDF', () => {
  it('is a file that has %PDF- within its first 1,024 bytes, under .pdf in any case', () => {
    const file = pdf({ pages: ['text'] });
    expect(sniffUpload('design.pdf', file)).toEqual({ ok: true, type: 'pdf' });
    expect(sniffUpload('DESIGN.PDF', file)).toEqual({ ok: true, type: 'pdf' });
  });

  it('may begin with junk before the header, as readers allow, up to the 1,024th byte', () => {
    const header = Buffer.from('%PDF-1.7\n');
    expect(sniffUpload('a.pdf', Buffer.concat([Buffer.alloc(1000, 0x20), header]))).toEqual({ ok: true, type: 'pdf' });
    expect(sniffUpload('a.pdf', Buffer.concat([Buffer.alloc(1020, 0x20), header]))).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it.each([
    ['an executable', EXECUTABLE],
    ['an ELF file', ELF],
    ['a Word file', docx({ blocks: [{ paragraph: 'x' }] })],
    ['a text file', Buffer.from('just some notes\n')],
    ['an OLE container', OLE],
  ])('is not %s named .pdf', (_label, file) => {
    expect(sniffUpload('design.pdf', file)).toMatchObject({ ok: false, reason: 'mismatch' });
  });
});

describe('a .docx', () => {
  it('is a ZIP archive, which is all the API can tell: a macro-enabled file passes here and the worker refuses it', () => {
    expect(sniffUpload('design.docx', docx({ blocks: [{ paragraph: 'x' }] }))).toEqual({ ok: true, type: 'docx' });
    expect(sniffUpload('macros.docx', docx({ blocks: [{ paragraph: 'x' }], macro: true }))).toEqual({ ok: true, type: 'docx' });
    expect(sniffUpload('Design.DOCX', zip([{ name: 'a', data: 'b' }]))).toEqual({ ok: true, type: 'docx' });
  });

  it('refuses an OLE container, which is the older .doc format or an encrypted Word file, with a reason of its own', () => {
    expect(sniffUpload('design.docx', OLE)).toMatchObject({ ok: false, reason: 'ole' });
  });

  it.each([
    ['a PDF', pdf({ pages: ['x'] })],
    ['an executable', EXECUTABLE],
    ['a text file', Buffer.from('plain text')],
  ])('is not %s named .docx', (_label, file) => {
    expect(sniffUpload('design.docx', file)).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('judges a ZIP by its four signature bytes alone, and refuses a file that has fewer', () => {
    expect(sniffUpload('a.docx', bytes(0x50, 0x4b, 0x03, 0x04))).toEqual({ ok: true, type: 'docx' });
    expect(sniffUpload('a.docx', bytes(0x50, 0x4b, 0x03))).toMatchObject({ ok: false, reason: 'mismatch' });
  });
});

describe('a text file', () => {
  it.each([
    ['notes.txt', 'txt'],
    ['README.md', 'md'],
    ['NOTES.TXT', 'txt'],
    ['Design.Md', 'md'],
  ])('%s is valid UTF-8 text of the type its extension names', (name, type) => {
    expect(sniffUpload(name, Buffer.from('# Title\n\nThe gateway forwards requests.\n'))).toEqual({ ok: true, type });
  });

  it('accepts multi-byte characters, a byte-order mark and every line ending', () => {
    expect(sniffUpload('a.txt', Buffer.from('Zürich \u{1F600} 日本語'))).toEqual({ ok: true, type: 'txt' });
    expect(sniffUpload('a.txt', Buffer.concat([bytes(0xef, 0xbb, 0xbf), Buffer.from('with a mark')]))).toEqual({ ok: true, type: 'txt' });
    expect(sniffUpload('a.md', Buffer.from('one\r\ntwo\rthree\nfour'))).toEqual({ ok: true, type: 'md' });
  });

  it('refuses text that is not UTF-8, because Scrylux does not guess encodings', () => {
    expect(sniffUpload('a.txt', bytes(0x63, 0x61, 0x66, 0xe9))).toMatchObject({ ok: false, reason: 'not_utf8' });
    expect(sniffUpload('a.md', bytes(0xff, 0xfe, 0x41, 0x00))).toMatchObject({ ok: false, reason: 'not_utf8' });
    expect(sniffUpload('a.txt', bytes(0xc0, 0xaf))).toMatchObject({ ok: false, reason: 'not_utf8' });
  });

  it('refuses text that holds a NUL byte, which Postgres cannot store and a text file does not have', () => {
    expect(sniffUpload('a.txt', Buffer.from('before\u0000after'))).toMatchObject({ ok: false, reason: 'nul' });
  });

  it('refuses a binary file named as text', () => {
    expect(sniffUpload('a.txt', EXECUTABLE)).toMatchObject({ ok: false });
    expect(sniffUpload('a.md', docx({ blocks: [{ paragraph: 'x' }] }))).toMatchObject({ ok: false });
    expect(sniffUpload('a.txt', pdf({ pages: ['x'] }))).toMatchObject({ ok: false });
  });
});

describe('every file', () => {
  it('is refused when it is empty, whatever its name', () => {
    for (const name of ['a.txt', 'a.md', 'a.pdf', 'a.docx']) expect(sniffUpload(name, Buffer.alloc(0))).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('is refused when its name has no supported extension, which the file-name schema catches first', () => {
    expect(sniffUpload('notes.doc', Buffer.from('x'))).toMatchObject({ ok: false, reason: 'extension' });
    expect(sniffUpload('notes', Buffer.from('x'))).toMatchObject({ ok: false, reason: 'extension' });
    expect(sniffUpload('notes.docm', zip([{ name: 'a', data: 'b' }]))).toMatchObject({ ok: false, reason: 'extension' });
  });

  it('is judged by its content and its extension together, never by a type the browser claims', () => {
    expect(sniffUpload('a.pdf', pdf({ pages: ['x'] }))).toEqual({ ok: true, type: 'pdf' });
    expect(sniffUpload('a.txt', pdf({ pages: ['x'] }))).toMatchObject({ ok: false });
    expect(sniffUpload('a.pdf', Buffer.from('plain'))).toMatchObject({ ok: false });
  });

  it('is judged without reading it whole: only the first bytes and, for text, a decode', () => {
    // A large PDF is judged from its header alone.
    const large = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024, 0)]);
    expect(sniffUpload('big.pdf', large)).toEqual({ ok: true, type: 'pdf' });
  });
});

describe('pasted text', () => {
  it('becomes the UTF-8 bytes of the text, which are stored and hashed as an uploaded .txt file would be', () => {
    const result = sniffPaste('Zürich \u{1F600}\nsecond line');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.toString('utf8')).toBe('Zürich \u{1F600}\nsecond line');
  });

  it('is refused when it holds a NUL', () => {
    expect(sniffPaste('a\u0000b')).toEqual({ ok: false, reason: 'nul' });
  });

  it('turns a lone surrogate into U+FFFD, as encoding it does, so the text stored is the text measured', () => {
    const result = sniffPaste('a\ud800b');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.toString('utf8')).toBe('a�b');
  });
});
