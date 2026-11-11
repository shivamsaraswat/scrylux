import { flagLabel } from '@scrylux/core';
import { Link } from 'react-router';
import { CitationList } from './CitationView.js';
import type { DraftItem } from './draft-items.js';

// The item selected on the diagram or in the list (Phase 3 Milestone 4, FR-062): why the model proposed it, the flags it proposed
// with the passages that support each, and the passages the item came from. A reviewer decides on an item by reading these.

/** Where the record an item matched is read: an element on the diagram, an asset or an assumption on the Assets and assumptions tab. */
const matchedRecord = (item: DraftItem, threatModelId: string): string =>
  item.group === 'asset' || item.group === 'assumption' ? `/threat-models/${threatModelId}/assets` : `/threat-models/${threatModelId}/diagram?element=${item.review.matched_id}`;

export function ItemPanel({ item, threatModelId, onAcceptWithChanges }: { item: DraftItem | null; threatModelId: string; onAcceptWithChanges?: () => void }) {
  return (
    <section className="draft-panel" aria-label="Selected item">
      {item === null ? (
        <p className="muted">Select an item to see why it was proposed and where it came from.</p>
      ) : (
        <>
          <h3>
            {item.typeLabel}: {item.title}
          </h3>
          <p className="draft-status">{item.status}</p>
          {onAcceptWithChanges !== undefined && item.review.state !== 'accepted' && item.review.comparison !== 'matched' && (
            <p>
              <button type="button" onClick={onAcceptWithChanges}>
                Accept…
              </button>
            </p>
          )}
          {item.comparison !== null && <p className="draft-comparison">{item.comparison}</p>}
          {item.review.matched_id !== null && (
            <p>
              <Link to={matchedRecord(item, threatModelId)}>Open the matching record</Link>
            </p>
          )}
          {item.differences.length > 0 && (
            <ul className="draft-differences" aria-label="Differences">
              {item.differences.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          )}
          {item.needs.length > 0 && (
            <ul className="draft-needs" aria-label="Needs">
              {item.needs.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          )}
          {item.facts.length > 0 && (
            <ul className="draft-facts">
              {item.facts.map((fact, index) => (
                <li key={index}>{fact}</li>
              ))}
            </ul>
          )}
          <h4>Why it was proposed</h4>
          <p>{item.rationale}</p>
          {item.flags.length > 0 && (
            <>
              <h4>Proposed flags</h4>
              <ul className="draft-flags">
                {item.flags.map((flag) => (
                  <li key={flag.flag}>
                    <strong>
                      {flagLabel(flag.flag)}: {flag.value ? 'Yes' : 'No'}
                    </strong>
                    <CitationList citations={flag.citations} threatModelId={threatModelId} />
                  </li>
                ))}
              </ul>
            </>
          )}
          <h4>Where it came from</h4>
          <CitationList citations={item.citations} threatModelId={threatModelId} />
        </>
      )}
    </section>
  );
}
