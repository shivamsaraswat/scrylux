import { flagLabel, type ProvenanceRecord } from '@scrylux/core';
import { CitationList } from '../draft/CitationView.js';
import { time } from './job-format.js';

// Where a record that an accept created, or a flag that an accept set, came from (Phase 3 Milestone 5, contracts/ui.md, FR-017): who accepted it and when, why the
// model proposed it, and the passages it cited, each with its source or "Source deleted". It is the record that is marked as AI's, or the flags that an accept
// set on a record a person drew, and nothing more: an element only some of whose flags came from the documents is not shown as AI's. A record a person created has
// none, and then nothing is shown. Every text is rendered as text, never as markup (Principle VI).

export function ProvenanceNotice({
  marks,
  threatModelId,
  flagValues = {},
}: {
  /** The provenance rows of one record: its own (no flag) and its flags'. */
  marks: readonly ProvenanceRecord[];
  threatModelId: string;
  /** The flags' values now, to say which each flag is. */
  flagValues?: Record<string, boolean>;
}) {
  const own = marks.find((mark) => mark.flag === null);
  const flags = marks.filter((mark) => mark.flag !== null);
  if (own === undefined && flags.length === 0) return null;
  const accepted = (mark: ProvenanceRecord): string => `Proposed by AI, accepted by ${mark.accepted_by.username} on ${time(mark.accepted_at)}`;
  return (
    <section aria-label="Where this came from" className="provenance">
      {own !== undefined && (
        <>
          <p>
            <strong>{accepted(own)}</strong>
          </p>
          <h4>Why it was proposed</h4>
          <p>{own.rationale}</p>
          <CitationList citations={own.citations} threatModelId={threatModelId} />
        </>
      )}
      {flags.length > 0 && (
        <>
          <h4>Flags set from the documents</h4>
          <ul>
            {flags.map((mark) => (
              <li key={mark.id}>
                <strong>
                  {flagLabel(mark.flag as string)}: {flagValues[mark.flag as string] === undefined ? 'set' : flagValues[mark.flag as string] ? 'Yes' : 'No'}
                </strong>
                <p className="muted">{accepted(mark)}</p>
                <CitationList citations={mark.citations} threatModelId={threatModelId} />
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
