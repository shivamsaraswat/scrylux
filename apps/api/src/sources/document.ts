import type { Block } from '../extract/types.js';
import type { DocumentModel } from './chunk.js';
import { codePointLength, markdownHeadings, normalizeText } from './text.js';

// From what a reader found to what the chunker cuts (Phase 3 Milestone 3, FR-014, FR-021, FR-022, research #6). The text is
// normalized once here, before anything is measured, so that the offsets of pages and headings and the lengths the limits
// count are those of the text that is chunked and stored.

/** A text file, Markdown or pasted text: its lines are recorded, and Markdown's headings. */
export function documentFromText(type: 'md' | 'txt' | 'text', raw: string): DocumentModel {
  const text = normalizeText(raw);
  return { text, lines: true, ...(type === 'md' ? { headings: markdownHeadings(text) } : {}) };
}

/**
 * The blocks of a PDF (one per page that has text) or a Word file (one per paragraph or table), joined with a line break. A block
 * that normalizes to nothing is left out. A PDF's page n starts where its block starts, and a page without a block starts where
 * the next page that has one does, so the page that holds a character is the last page that starts at or before it.
 */
export function documentFromBlocks(type: 'pdf' | 'docx', blocks: readonly Block[]): DocumentModel {
  const kept = blocks.map((block) => ({ ...block, text: normalizeText(block.text) })).filter((block) => block.text.trim() !== '');
  const starts: number[] = [];
  const headings: { offset: number; text: string }[] = [];
  const firstOfPage = new Map<number, number>();
  let offset = 0;
  for (const block of kept) {
    starts.push(offset);
    if (block.isHeading === true) headings.push({ offset, text: block.text.trim() });
    if (block.page !== undefined && !firstOfPage.has(block.page)) firstOfPage.set(block.page, offset);
    offset += codePointLength(block.text) + 1;
  }
  const text = kept.map((block) => block.text).join('\n');

  if (type === 'pdf') {
    const lastPage = Math.max(0, ...firstOfPage.keys());
    const pageStarts: number[] = [];
    // Walk down from the last page, so that a page with no text takes the start of the next one that has some.
    let next = codePointLength(text);
    for (let page = lastPage; page >= 1; page--) {
      next = firstOfPage.get(page) ?? next;
      pageStarts[page - 1] = next;
    }
    return { text, lines: false, pageStarts };
  }
  return { text, lines: false, headings };
}
