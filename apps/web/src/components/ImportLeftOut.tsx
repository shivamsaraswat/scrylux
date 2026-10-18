import { ImportSummary } from '@scrylux/core';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ImportNotes } from './ImportNotes.js';

// What an import left out, on the page of the one threat model it created (spec FR-013a, FR-016, US1/AC2, US4/AC2). The
// import hands its summary over in the navigation state; this keeps it for the visit and drops it from the history entry,
// so a reload, or coming back to the page later, shows the page as before. Nothing is stored.
// `returnFocusTo` is where the focus goes when the region is dismissed: the button that had it is gone with the region.
export function ImportLeftOut({ returnFocusTo }: { returnFocusTo: RefObject<HTMLElement | null> }) {
  const location = useLocation();
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const [notes, setNotes] = useState<ImportSummary['notes'] | null>(() => {
    // The state is the history entry's, which anything could have put there: it is read as a summary or not at all.
    const state = location.state as { importSummary?: unknown } | null;
    const parsed = ImportSummary.safeParse(state?.importSummary);
    return parsed.success && parsed.data.notes.length > 0 ? parsed.data.notes : null;
  });

  useEffect(() => {
    if (location.state !== null) void navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
    // Once, for the entry the user arrived on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The user was sent here by the import, so what it says takes the focus, as its result panel did.
  const shown = notes !== null;
  useEffect(() => {
    if (shown) heading.current?.focus();
  }, [shown]);

  if (notes === null) return null;
  return (
    <section aria-label="What the import left out">
      <h2 ref={heading} tabIndex={-1}>
        What the import left out
      </h2>
      <p>{notes.length} parts of this file weren&apos;t carried over or were changed to fit.</p>
      <ImportNotes notes={notes} />
      <div className="actions">
        <button
          type="button"
          onClick={() => {
            setNotes(null);
            returnFocusTo.current?.focus();
          }}
        >
          Dismiss
        </button>
      </div>
    </section>
  );
}
