import { DRAFT_LIMITS, ELEMENT_FLAGS, type DraftAnswer, type DraftAnswerCitation, type ElementType } from '@scrylux/core';

// The checks of an extraction's answer that depend on the request (Phase 3 Milestone 4, research #2, FR-030 to FR-034): which labels
// were sent, what each chunk says, what each reference names, and the rules of the threat model's diagram, so that Milestone 5 can
// accept any item as it stands. They are added to the answer's fixed schema as a refinement (`DraftAnswer.superRefine(checksFor(sent))`),
// so a failed check is a schema attempt of the provider layer, retried with its issues in the next request, and never reaches the
// JSON Schema a provider is sent.
//
// Every issue is a fixed message at a path, and never quotes anything the model wrote: the issues go back to the model in the next
// request, after the marked content section, so a name, a reference, a label or a quote that came from a document must not travel
// with them. A path is made of the answer's own field names and positions. The test holds both.

export interface SentChunk {
  /** `c1`, `c2`…: the label the chunk was sent under (FR-036). */
  label: string;
  text: string;
}

type PathPart = string | number;

/** Where an issue goes: zod's refinement context, or anything that collects issues. */
export interface IssueSink {
  addIssue(issue: { code: 'custom'; message: string; path: PathPart[] }): void;
}

const MESSAGES = {
  labelNotSent: 'cites a chunk that was not sent',
  quoteNotInChunk: 'is not in the cited chunk',
  quoteTooShort: 'is too short once whitespace is collapsed',
  refUsedTwice: 'is already the ref of another item',
  notABoundary: 'does not name a trust boundary',
  flowInBoundary: 'a data flow sits in no boundary',
  notAnEndpoint: 'does not name a process, a data store or an external entity',
  endpointMissing: 'a data flow needs this endpoint',
  endpointOnNonFlow: 'only a data flow has this field',
  flowToItself: 'a data flow cannot start and end at the same element',
  notAnElement: 'does not name an element',
  holderTwice: 'names the same element twice',
  boundaryCycle: 'puts a trust boundary inside itself',
  nameUsedTwice: 'is the name of another item of the same kind',
  flagNotForType: 'does not apply to this type of element',
  flagTwice: 'is given twice for this element',
  reasonRequired: 'is required when there is no item',
  reasonNotAllowed: 'must be null when there are items',
} as const;

// ---- Quotes -------------------------------------------------------------------------------------------------------------

const isWhitespace = (character: string): boolean => /\s/u.test(character);

interface Collapsed {
  /** The text with every run of whitespace as one space, one string per code point. */
  points: string[];
  /** For each code point of `points`, where it is in the original text, counted in code points. */
  origin: number[];
}

/** Collapses runs of Unicode whitespace to one space, keeping where every remaining code point came from. */
function collapse(text: string): Collapsed {
  const points: string[] = [];
  const origin: number[] = [];
  let position = 0;
  let inRun = false;
  for (const character of text) {
    if (isWhitespace(character)) {
      if (!inRun) {
        points.push(' ');
        origin.push(position);
      }
      inRun = true;
    } else {
      points.push(character);
      origin.push(position);
      inRun = false;
    }
    position++;
  }
  return { points, origin };
}

/** A quote with its whitespace collapsed and its ends trimmed, as a string. */
export function collapseQuote(quote: string): string {
  return collapse(quote).points.join('').trim();
}

/**
 * Finds a passage in a chunk's text with runs of whitespace treated as one space, on either side, and nothing else relaxed: case,
 * punctuation and quotation marks must match (FR-032). Returns where the passage is in the chunk's own text, from its first code
 * point to the end of its last, counted in code points as Milestone 3 counts a chunk's offsets, or null. The first match is taken.
 */
export function findQuote(chunkText: string, quote: string): { start: number; end: number } | null {
  const wanted = collapseQuote(quote);
  if (wanted === '') return null;
  const { points, origin } = collapse(chunkText);
  const haystack = points.join('');
  // A UTF-16 offset in `haystack` to the code point it starts, or -1 inside a surrogate pair.
  const startsAt: number[] = new Array<number>(haystack.length + 1).fill(-1);
  let offset = 0;
  points.forEach((point, index) => {
    startsAt[offset] = index;
    offset += point.length;
  });
  startsAt[offset] = points.length;

  let from = 0;
  for (;;) {
    const found = haystack.indexOf(wanted, from);
    if (found === -1) return null;
    const first = startsAt[found] ?? -1;
    const after = startsAt[found + wanted.length] ?? -1;
    if (first !== -1 && after !== -1) {
      // The quote is trimmed, so its last code point is not whitespace and keeps its own position.
      return { start: origin[first] as number, end: (origin[after - 1] as number) + 1 };
    }
    from = found + 1;
  }
}

// ---- The checks ---------------------------------------------------------------------------------------------------------

const ENDPOINT_TYPES: ReadonlySet<ElementType> = new Set<ElementType>(['process', 'data_store', 'external_entity']);

interface Known {
  list: 'elements' | 'assets' | 'assumptions';
  index: number;
  type: ElementType | null;
  boundary: string | null;
}

/**
 * The refinement for one request: `sent` are the chunks it carried, by label. Call it with the answer and anything that collects
 * issues (zod's refinement context). It adds one issue for each problem, in a fixed order: the references, then each element,
 * asset and assumption, then the nesting of boundaries, then the reason for an empty answer.
 */
export function checksFor(sent: readonly SentChunk[]): (answer: DraftAnswer, ctx: IssueSink) => void {
  const chunks = new Map(sent.map((chunk) => [chunk.label, chunk.text]));

  return (answer, ctx) => {
    const issue = (message: string, path: PathPart[]): void => ctx.addIssue({ code: 'custom', message, path });

    const checkCitations = (citations: readonly DraftAnswerCitation[], path: PathPart[]): void => {
      citations.forEach((citation, j) => {
        const text = chunks.get(citation.chunk);
        if (text === undefined) return issue(MESSAGES.labelNotSent, [...path, j, 'chunk']);
        if ([...collapseQuote(citation.quote)].length < DRAFT_LIMITS.quoteMin) return issue(MESSAGES.quoteTooShort, [...path, j, 'quote']);
        if (findQuote(text, citation.quote) === null) issue(MESSAGES.quoteNotInChunk, [...path, j, 'quote']);
      });
    };

    // Every ref names one item, across the three lists. The first to use a ref keeps it.
    const known = new Map<string, Known>();
    const register = (ref: string, entry: Known, path: PathPart[]): void => {
      if (known.has(ref)) issue(MESSAGES.refUsedTwice, path);
      else known.set(ref, entry);
    };
    answer.elements.forEach((element, i) => register(element.ref, { list: 'elements', index: i, type: element.type, boundary: element.boundary }, ['elements', i, 'ref']));
    answer.assets.forEach((asset, i) => register(asset.ref, { list: 'assets', index: i, type: null, boundary: null }, ['assets', i, 'ref']));
    answer.assumptions.forEach((assumption, i) => register(assumption.ref, { list: 'assumptions', index: i, type: null, boundary: null }, ['assumptions', i, 'ref']));

    const elementOf = (ref: string): Known | undefined => {
      const entry = known.get(ref);
      return entry?.list === 'elements' ? entry : undefined;
    };

    // Names are compared ignoring case, within one kind (FR-034).
    const names = new Set<string>();
    const checkName = (kind: string, name: string, path: PathPart[]): void => {
      const key = `${kind}:${name.toLowerCase()}`;
      if (names.has(key)) issue(MESSAGES.nameUsedTwice, path);
      else names.add(key);
    };

    answer.elements.forEach((element, i) => {
      const at = ['elements', i] as PathPart[];
      checkName(element.type, element.name, [...at, 'name']);

      if (element.type === 'data_flow') {
        if (element.boundary !== null) issue(MESSAGES.flowInBoundary, [...at, 'boundary']);
        for (const end of ['source', 'target'] as const) {
          const ref = element[end];
          if (ref === null) {
            issue(MESSAGES.endpointMissing, [...at, end]);
            continue;
          }
          const endpoint = elementOf(ref);
          if (endpoint === undefined || endpoint.type === null || !ENDPOINT_TYPES.has(endpoint.type)) issue(MESSAGES.notAnEndpoint, [...at, end]);
        }
        if (element.source !== null && element.source === element.target && elementOf(element.source) !== undefined) {
          issue(MESSAGES.flowToItself, [...at, 'target']);
        }
      } else {
        if (element.boundary !== null && elementOf(element.boundary)?.type !== 'trust_boundary') issue(MESSAGES.notABoundary, [...at, 'boundary']);
        for (const end of ['source', 'target'] as const) {
          if (element[end] !== null) issue(MESSAGES.endpointOnNonFlow, [...at, end]);
        }
      }

      const allowed: ReadonlySet<string> = new Set(ELEMENT_FLAGS[element.type]);
      const given = new Set<string>();
      element.flags.forEach((flag, k) => {
        if (!allowed.has(flag.flag)) issue(MESSAGES.flagNotForType, [...at, 'flags', k, 'flag']);
        else if (given.has(flag.flag)) issue(MESSAGES.flagTwice, [...at, 'flags', k, 'flag']);
        else given.add(flag.flag);
        checkCitations(flag.citations, [...at, 'flags', k, 'citations']);
      });
      checkCitations(element.citations, [...at, 'citations']);
    });

    answer.assets.forEach((asset, i) => {
      const at = ['assets', i] as PathPart[];
      checkName('asset', asset.name, [...at, 'name']);
      const holders = new Set<string>();
      asset.held_by.forEach((ref, k) => {
        if (elementOf(ref) === undefined) issue(MESSAGES.notAnElement, [...at, 'held_by', k]);
        else if (holders.has(ref)) issue(MESSAGES.holderTwice, [...at, 'held_by', k]);
        else holders.add(ref);
      });
      checkCitations(asset.citations, [...at, 'citations']);
    });

    answer.assumptions.forEach((assumption, i) => checkCitations(assumption.citations, ['assumptions', i, 'citations']));

    reportBoundaryCycles(answer, known, (path) => issue(MESSAGES.boundaryCycle, path));

    const empty = answer.elements.length === 0 && answer.assets.length === 0 && answer.assumptions.length === 0;
    if (empty && answer.nothing_found === null) issue(MESSAGES.reasonRequired, ['nothing_found']);
    if (!empty && answer.nothing_found !== null) issue(MESSAGES.reasonNotAllowed, ['nothing_found']);
  };
}

/**
 * A trust boundary nested in itself, directly or through others, once for each cycle, at the first boundary of the cycle in the
 * answer (research #2). A boundary that only leads into a cycle is not part of it and is not reported.
 */
function reportBoundaryCycles(answer: DraftAnswer, known: ReadonlyMap<string, Known>, report: (path: PathPart[]) => void): void {
  const boundaryAt = new Map<string, number>();
  answer.elements.forEach((element, i) => {
    if (element.type === 'trust_boundary' && known.get(element.ref)?.index === i) boundaryAt.set(element.ref, i);
  });

  const done = new Set<string>();
  for (const [start] of boundaryAt) {
    if (done.has(start)) continue;
    const walked = new Map<string, number>();
    const order: string[] = [];
    let current: string | null = start;
    while (current !== null) {
      const index = boundaryAt.get(current);
      if (index === undefined || done.has(current)) break;
      const seen = walked.get(current);
      if (seen !== undefined) {
        const members = order.slice(seen);
        const first = Math.min(...members.map((ref) => boundaryAt.get(ref) as number));
        report(['elements', first, 'boundary']);
        break;
      }
      walked.set(current, order.length);
      order.push(current);
      current = (answer.elements[index] as { boundary: string | null }).boundary;
    }
    for (const ref of order) done.add(ref);
  }
}
