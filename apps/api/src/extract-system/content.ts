import type { SentChunk } from './checks.js';

// What an extraction's request carries about the sources (Phase 3 Milestone 4, research #3, FR-020, FR-036): the chosen chunks
// under labels c1, c2… in the order they are sent, each with a header line that names its source and where in it the chunk is.
// All of it goes in the one place a provider's request holds untrusted content, the layer's marked content section. No chunk
// identifier and no source identifier is put in front of the model, so a citation outside the request cannot even be written, and
// the answer is mapped back to the chunks by the labels.

/** The most chunks one request carries: the labels `c1`…`c1000`, which the answer's label pattern allows (research #5). */
export const MAX_CHUNKS_PER_REQUEST = 1000;

export interface ChunkForPrompt {
  /** Never sent. It is how the answer is mapped back to the chunk. */
  id: string;
  sourceId: string;
  sourceName: string;
  pageFirst: number | null;
  pageLast: number | null;
  lineFirst: number | null;
  lineLast: number | null;
  heading: string | null;
  text: string;
}

/** A chunk as the answer's labels refer to it: what a citation resolves to and what its quote is checked against. */
export interface LabelledChunk extends SentChunk {
  chunkId: string;
}

// A name or a heading is text from a document, or a title a person typed. It must not be able to start a header line of its own,
// so every run of whitespace and control characters, line separators included, becomes one space.
// eslint-disable-next-line no-control-regex -- the point is to remove control characters
const LINE_BREAKING_OR_CONTROL = /[\s\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu;
const oneLine = (text: string): string => text.replace(LINE_BREAKING_OR_CONTROL, ' ').trim();

function range(first: number | null, last: number | null, one: string, many: string): string | null {
  if (first === null || last === null) return null;
  return first === last ? `${one} ${first}` : `${many} ${first}-${last}`;
}

function header(label: string, chunk: ChunkForPrompt): string {
  const where = [
    range(chunk.pageFirst, chunk.pageLast, 'page', 'pages'),
    range(chunk.lineFirst, chunk.lineLast, 'line', 'lines'),
    chunk.heading === null ? null : `section: ${oneLine(chunk.heading)}`,
  ].filter((part): part is string => part !== null);
  return [`[${label}] ${oneLine(chunk.sourceName)}`, ...where].join(', ');
}

/**
 * The content section for these chunks, in the order given, and the labels that map an answer back to them. A chunk's text is
 * verbatim: a quote is checked against it, with runs of whitespace as one (FR-032).
 */
export function buildContent(chunks: readonly ChunkForPrompt[]): { content: string; labels: LabelledChunk[] } {
  if (chunks.length === 0) throw new RangeError('an extraction needs at least one chunk');
  if (chunks.length > MAX_CHUNKS_PER_REQUEST) throw new RangeError(`an extraction sends at most ${MAX_CHUNKS_PER_REQUEST.toLocaleString('en-US')} chunks`);
  const labels: LabelledChunk[] = [];
  const parts = chunks.map((chunk, index) => {
    const label = `c${index + 1}`;
    labels.push({ label, text: chunk.text, chunkId: chunk.id });
    return `${header(label, chunk)}\n${chunk.text}`;
  });
  return { content: parts.join('\n\n'), labels };
}
