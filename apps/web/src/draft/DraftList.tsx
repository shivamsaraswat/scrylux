import { GROUP_HEADING, GROUP_ORDER, shortStatus, type DraftItem } from './draft-items.js';

// Every item of the draft, by kind (Phase 3 Milestone 4, FR-060), so that the draft can be read without the diagram. It shares its
// selection with the diagram. Each item says beside it where it stands in the review: decided, or how it compares with the threat model
// (Phase 3 Milestone 5, FR-001, FR-002). Names and statements are rendered as text (FR-066).

export function DraftList({
  items,
  selectedId,
  checked,
  onSelect,
  onToggle,
}: {
  items: readonly DraftItem[];
  selectedId: string | null;
  /** The items chosen for a decision (Phase 3 Milestone 5): a checkbox each, so that a person can choose several by keyboard. */
  checked: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  return (
    <section className="draft-list" aria-label="Draft items">
      {GROUP_ORDER.map((group) => {
        const inGroup = items.filter((item) => item.group === group);
        if (inGroup.length === 0) return null;
        return (
          <div key={group}>
            <h3>{`${GROUP_HEADING[group]} (${inGroup.length})`}</h3>
            <ul>
              {inGroup.map((item) => (
                <li key={item.id} className={`draft-row draft-row--${item.review.state}`}>
                  <input type="checkbox" aria-label={`Select ${item.typeLabel}: ${item.title}`} checked={checked.has(item.id)} onChange={() => onToggle(item.id)} />{' '}
                  <button type="button" className="draft-item" aria-pressed={item.id === selectedId} onClick={(event) => (event.shiftKey ? onToggle(item.id) : onSelect(item.id))}>
                    {item.title}
                  </button>{' '}
                  <span className="draft-state">{shortStatus(item)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
