import type { CitationRecord, CitedChunk } from '@scrylux/core';
import { Link } from 'react-router';
import { remaining } from './draft-items.js';

// The citations of an item or a flag (Phase 3 Milestone 4, FR-054, FR-062): each names its source and where in it the chunk is, shows
// the passage the model quoted, and opens the source at that chunk. A citation whose source was deleted says so and never vanishes
// silently, and an item left with none that still points at a chunk says that too. Everything is text, never markup (FR-066).

const range = (first: number | null, last: number | null, one: string, many: string): string | null => {
  if (first === null || last === null) return null;
  return first === last ? `${one} ${first}` : `${many} ${first}-${last}`;
};

/** Where a chunk is in its source, in words: its pages, its lines, its nearest heading. */
export function locationText(chunk: Pick<CitedChunk, 'page_first' | 'page_last' | 'line_first' | 'line_last' | 'heading'>): string {
  return [
    range(chunk.page_first, chunk.page_last, 'page', 'pages'),
    range(chunk.line_first, chunk.line_last, 'line', 'lines'),
    chunk.heading === null ? null : `section: ${chunk.heading}`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
}

export function CitationList({ citations, threatModelId }: { citations: readonly CitationRecord[]; threatModelId: string }) {
  return (
    <>
      {citations.length > 0 && (
        <ul className="draft-citations">
          {citations.map((citation, index) =>
            citation.chunk === null || citation.quote === null ? (
              <li key={index}>Source deleted</li>
            ) : (
              <li key={index}>
                <strong>{citation.chunk.source_name}</strong>
                {locationText(citation.chunk) !== '' && <>, {locationText(citation.chunk)}</>}
                <blockquote className="draft-quote">{citation.quote}</blockquote>
                <Link to={`/threat-models/${threatModelId}/sources/${citation.chunk.source_id}?offset=${citation.chunk.position}`}>Open in source</Link>
              </li>
            ),
          )}
        </ul>
      )}
      {remaining(citations).length === 0 && <p className="muted">No remaining citation</p>}
    </>
  );
}
