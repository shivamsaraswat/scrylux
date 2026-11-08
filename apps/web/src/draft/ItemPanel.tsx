import { flagLabel } from '@scrylux/core';
import { CitationList } from './CitationView.js';
import type { DraftItem } from './draft-items.js';

// The item selected on the diagram or in the list (Phase 3 Milestone 4, FR-062): why the model proposed it, the flags it proposed
// with the passages that support each, and the passages the item came from. A reviewer decides on an item by reading these.

export function ItemPanel({ item, threatModelId }: { item: DraftItem | null; threatModelId: string }) {
  return (
    <section className="draft-panel" aria-label="Selected item">
      {item === null ? (
        <p className="muted">Select an item to see why it was proposed and where it came from.</p>
      ) : (
        <>
          <h3>
            {item.typeLabel}: {item.title}
          </h3>
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
