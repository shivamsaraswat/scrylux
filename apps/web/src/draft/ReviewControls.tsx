import type { DecisionResult, DraftRecord } from '@scrylux/core';
import type { UseMutationResult } from '@tanstack/react-query';
import { writeErrorMessage } from '../api/errors.js';
import type { DraftDecision } from '@scrylux/core';
import type { DraftItem } from './draft-items.js';

// The toolbar over the draft's list (Phase 3 Milestone 5, contracts/ui.md items 3, 4, 6, 7): it acts on the items chosen with the checkboxes. Accept
// is enabled only for items that are open to it, and when what an element needs is chosen with it, and it says in words what is missing (FR-003).
// A request carries the draft's id and, for each item, its id and the comparison the page showed; the server builds the records (FR-007).

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What stops the chosen items being accepted, in words. Empty when they can be. */
function reasonsFor(chosen: readonly DraftItem[]): string[] {
  const ids = new Set(chosen.map((item) => item.id));
  const reasons: string[] = [];
  if (chosen.some((item) => item.review.state === 'accepted')) reasons.push('Already accepted');
  for (const item of chosen) {
    if (item.review.state === 'accepted') continue;
    (item.review.needs ?? []).forEach((need, index) => {
      if (!ids.has(need.item_id)) reasons.push(item.needs[index] ?? '');
    });
  }
  return [...new Set(reasons.filter((reason) => reason !== ''))];
}

function Result({ result }: { result: DecisionResult }) {
  const name = (id: string): string => result.draft.elements.find((element) => element.id === id)?.name ?? 'an element';
  return (
    <div role="status" aria-label="Result of the last decision">
      <p>
        Created {plural(result.created, 'record', 'records')} and changed {result.changed}.
      </p>
      {result.unlinked_holders.map((held, index) => (
        <p key={index}>Held by {name(held.element_item_id)} was not linked: it is not in the threat model.</p>
      ))}
    </div>
  );
}

export function ReviewControls({
  decide,
  draft,
  items,
  chosen,
  onDecided,
}: {
  /** The page's one decision, shared with the form that accepts with changes, so that its answer is shown in one place. */
  decide: UseMutationResult<DecisionResult, Error, DraftDecision>;
  draft: DraftRecord;
  items: readonly DraftItem[];
  chosen: ReadonlySet<string>;
  onDecided: () => void;
}) {
  const picked = items.filter((item) => chosen.has(item.id));
  const reasons = reasonsFor(picked);
  const canAccept = picked.length > 0 && reasons.length === 0 && !decide.isPending;

  const accept = () =>
    decide.mutate(
      {
        action: 'accept',
        draft_id: draft.id,
        items: picked.map((item) => ({ id: item.id, seen: item.review.comparison ?? 'new' })),
      },
      { onSuccess: onDecided },
    );

  // Rejecting writes nothing to the threat model, and a rejected item can come back (FR-014). Neither names more than the items.
  const canReject = picked.length > 0 && picked.every((item) => item.review.state === 'undecided') && !decide.isPending;
  const canReturn = picked.length > 0 && picked.every((item) => item.review.state === 'rejected') && !decide.isPending;
  const mark = (action: 'reject' | 'undecide') => decide.mutate({ action, draft_id: draft.id, items: picked.map((item) => ({ id: item.id })) }, { onSuccess: onDecided });

  return (
    <div>
      <div role="toolbar" aria-label="Review">
        <span>{picked.length} selected</span>{' '}
        <button type="button" disabled={!canAccept} onClick={accept}>
          Accept
        </button>{' '}
        <button type="button" disabled={!canReject} onClick={() => mark('reject')}>
          Reject
        </button>{' '}
        <button type="button" disabled={!canReturn} onClick={() => mark('undecide')}>
          Return to undecided
        </button>
        {reasons.map((reason) => (
          <p key={reason} className="muted">
            {reason}
          </p>
        ))}
      </div>
      {decide.isSuccess && <Result result={decide.data} />}
      {decide.isError && (
        <p role="alert" aria-label="Decision refused">
          {writeErrorMessage(decide.error)}
        </p>
      )}
    </div>
  );
}
