import { CHUNK_MAX_CHARS, HEADING_MAX_CHARS } from '@scrylux/core';

// The chunker (Phase 3 Milestone 3, FR-020 to FR-022, research #7): consecutive slices of the extracted text, none longer
// than 2,000 code points, with no gap and no overlap, so that reading them in order gives the text back exactly. Offsets
// are code points. A cut prefers, in this order, a page break, the start of a heading, a blank line, a line end, a sentence
// end and a space, among the cuts that leave a chunk of 1,000 to 2,000 code points; with none there, among those that leave
// any chunk; with none at all, the cut falls where the limit does. A cut never leaves a chunk, or a remainder, of nothing
// but whitespace, except inside a run of whitespace longer than a chunk, where it cannot be avoided without changing the text.

export interface DocumentModel {
  /** Normalized text (text.ts). */
  text: string;
  /** PDFs: page n (1-based) starts at pageStarts[n - 1], in code points, ascending. A page with no text shares the next one's start. */
  pageStarts?: number[];
  /** Markdown and Word: where each heading starts, ascending. */
  headings?: { offset: number; text: string }[];
  /** Text files: record the first and last line of each chunk. */
  lines: boolean;
}

export interface ChunkDraft {
  position: number;
  startOffset: number;
  endOffset: number;
  text: string;
  pageFirst: number | null;
  pageLast: number | null;
  lineFirst: number | null;
  lineLast: number | null;
  heading: string | null;
}

/** Where a cut is welcome to fall, best first. */
const PAGE = 0;
const HEADING = 1;
const BLANK_LINE = 2;
const LINE_END = 3;
const SENTENCE_END = 4;
const SPACE = 5;
const CLASSES = 6;

const WINDOW_START = 1000;

// JavaScript's \s, for code points.
function isSpace(cp: number): boolean {
  return (
    cp === 32 || (cp >= 9 && cp <= 13) || cp === 0xa0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000 || cp === 0xfeff
  );
}

const isClosing = (cp: number): boolean => cp === 0x22 || cp === 0x27 || cp === 0x29 || cp === 0x5d;
const isTerminator = (cp: number): boolean => cp === 0x2e || cp === 0x21 || cp === 0x3f;

/** The number of entries of a sorted array that are at most `value`. */
function countAtMost(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] as number) <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** Every place a cut could fall, by class, found in one pass over the whitespace of the text. */
function candidates(points: Uint32Array, model: DocumentModel, lastNonSpace: number): number[][] {
  const classes: number[][] = Array.from({ length: CLASSES }, () => []);
  const usable = (offset: number): boolean => Number.isInteger(offset) && offset > 0 && offset <= lastNonSpace;
  classes[PAGE] = [...new Set(model.pageStarts ?? [])].filter(usable).sort((a, b) => a - b);
  classes[HEADING] = [...new Set((model.headings ?? []).map((h) => h.offset))].filter(usable).sort((a, b) => a - b);

  const n = points.length;
  for (let i = 0; i < n; ) {
    if (!isSpace(points[i] as number)) {
      i++;
      continue;
    }
    // A run of whitespace is a boundary only when something follows it, and it goes to the chunk before, except that the
    // indent of the next line stays with that line.
    let end = i;
    let newlines = 0;
    let lastNewline = -1;
    while (end < n && isSpace(points[end] as number)) {
      if (points[end] === 10) {
        newlines++;
        lastNewline = end;
      }
      end++;
    }
    if (end < n) {
      if (newlines >= 2) classes[BLANK_LINE]?.push(lastNewline + 1);
      else if (newlines === 1) classes[LINE_END]?.push(lastNewline + 1);
      else {
        classes[SPACE]?.push(end);
        // A sentence ends with . ! or ?, perhaps followed by closing quotes or brackets, then a space.
        let before = i - 1;
        while (before >= 0 && isClosing(points[before] as number)) before--;
        if (before >= 0 && isTerminator(points[before] as number)) classes[SENTENCE_END]?.push(end);
      }
    }
    i = end;
  }
  return classes;
}

const truncate = (text: string): string => (Array.from(text).length <= HEADING_MAX_CHARS ? text : Array.from(text).slice(0, HEADING_MAX_CHARS).join(''));

export function chunkDocument(model: DocumentModel): ChunkDraft[] {
  const points = Uint32Array.from(model.text, (char) => char.codePointAt(0) as number);
  const n = points.length;
  let lastNonSpace = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isSpace(points[i] as number)) {
      lastNonSpace = i;
      break;
    }
  }
  if (lastNonSpace < 0) return [];

  const byClass = candidates(points, model, lastNonSpace);
  const pageStarts = [...(model.pageStarts ?? [])].sort((a, b) => a - b);
  const headings = [...(model.headings ?? [])].sort((a, b) => a.offset - b.offset);
  const headingOffsets = headings.map((h) => h.offset);
  const newlines: number[] = [];
  if (model.lines) for (let i = 0; i < n; i++) if (points[i] === 10) newlines.push(i);

  /** The best cut for a chunk that starts at `start`: the last one of the best class that has one in [from, to]. */
  function pick(from: number, to: number): number | undefined {
    for (const positions of byClass) {
      const index = countAtMost(positions, to) - 1;
      const found = index >= 0 ? positions[index] : undefined;
      if (found !== undefined && found >= from) return found;
    }
    return undefined;
  }

  const chunks: ChunkDraft[] = [];
  let start = 0;
  while (start < n) {
    let end: number;
    if (n - start <= CHUNK_MAX_CHARS) {
      end = n;
    } else {
      // The remainder keeps a character that is not whitespace, and the chunk holds one.
      const to = Math.min(start + CHUNK_MAX_CHARS, lastNonSpace);
      let firstNonSpace = start;
      while (firstNonSpace < n && isSpace(points[firstNonSpace] as number)) firstNonSpace++;
      const floor = Math.max(start + 1, firstNonSpace + 1);
      end = (floor <= to ? (pick(Math.max(start + WINDOW_START, floor), to) ?? pick(floor, to) ?? to) : undefined) ?? Math.min(start + CHUNK_MAX_CHARS, n);
    }

    const pageOf = (offset: number): number => countAtMost(pageStarts, offset);
    const lineOf = (offset: number): number => 1 + countAtMost(newlines, offset - 1);
    const heading = countAtMost(headingOffsets, start) - 1;
    chunks.push({
      position: chunks.length,
      startOffset: start,
      endOffset: end,
      text: String.fromCodePoint(...points.subarray(start, end)),
      pageFirst: pageStarts.length > 0 ? pageOf(start) : null,
      pageLast: pageStarts.length > 0 ? pageOf(end - 1) : null,
      lineFirst: model.lines ? lineOf(start) : null,
      lineLast: model.lines ? lineOf(end - 1) : null,
      heading: heading >= 0 ? truncate((headings[heading] as { text: string }).text) : null,
    });
    start = end;
  }
  return chunks;
}
