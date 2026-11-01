import { HEADING_MAX_CHARS } from '@scrylux/core';

// Text is normalized once, before it is measured or chunked (Phase 3 Milestone 3, FR-021, FR-022, research #6). Every
// length and offset counts code points, which is what Postgres's char_length counts, so a chunk's offsets and its stored
// text agree. Every line break becomes exactly one LF, so a line number counted in the normalized text is the line number
// of the text as received.

/** The number of code points: a character outside the basic plane counts once, a lone surrogate counts once. */
export function codePointLength(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i++;
    }
    count++;
  }
  return count;
}

/** UTF-8 text without its leading byte-order mark. Bytes that are not UTF-8 throw a TypeError: Scrylux does not guess encodings. */
export function decodeUtf8(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Line breaks (CRLF, CR) as LF, first, so that a NUL between two of them cannot merge them; then NUL removed, which a text layer
 * can hold and Postgres text refuses; then a lone surrogate replaced by U+FFFD, so that the text stored is the text measured.
 */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replaceAll('\u0000', '').replace(LONE_SURROGATE, '�');
}

export interface Heading {
  /** In code points from the start of the text: where the heading's line starts. */
  offset: number;
  text: string;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const UNDERLINE = /^ {0,3}(?:=+|-{2,})[ \t]*$/;

const truncate = (text: string): string => (codePointLength(text) <= HEADING_MAX_CHARS ? text : Array.from(text).slice(0, HEADING_MAX_CHARS).join(''));

/**
 * The headings of Markdown, in order: ATX lines (# to ######) and setext ones (a line of text underlined with = or --), outside
 * fenced code blocks. Markdown is never rendered; this only tells where a section starts so that a chunk can name it.
 */
export function markdownHeadings(text: string): Heading[] {
  const headings: Heading[] = [];
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  // The line before this one, if it is a paragraph line a setext underline could turn into a heading.
  let paragraph: { offset: number; text: string } | null = null;

  for (const line of text.split('\n')) {
    const here = offset;
    offset += codePointLength(line) + 1;

    const opening = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const closes = opening?.[1] !== undefined && opening[1][0] === fence.char && opening[1].length >= fence.length && line.slice(opening[0].length).trim() === '';
      if (closes) fence = null;
      paragraph = null;
      continue;
    }
    if (opening?.[1] !== undefined) {
      fence = { char: opening[1][0] as string, length: opening[1].length };
      paragraph = null;
      continue;
    }

    const atx = ATX.exec(line);
    if (atx !== null) {
      const title = (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+$/, '').trim();
      if (title !== '') headings.push({ offset: here, text: truncate(title) });
      paragraph = null;
      continue;
    }
    if (paragraph !== null && UNDERLINE.test(line)) {
      headings.push({ offset: paragraph.offset, text: truncate(paragraph.text) });
      paragraph = null;
      continue;
    }
    // Four spaces of indent make code, not a paragraph; a blank line ends one.
    paragraph = line.trim() === '' || /^ {4}/.test(line) ? null : { offset: here, text: line.trim() };
  }
  return headings;
}
