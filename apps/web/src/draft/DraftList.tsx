import { GROUP_HEADING, GROUP_ORDER, type DraftItem } from './draft-items.js';

// Every item of the draft, by kind (Phase 3 Milestone 4, FR-060), so that the draft can be read without the diagram. It shares its
// selection with the diagram. Names and statements are rendered as text (FR-066).

export function DraftList({ items, selectedId, onSelect }: { items: readonly DraftItem[]; selectedId: string | null; onSelect: (id: string) => void }) {
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
                <li key={item.id}>
                  <button type="button" className="draft-item" aria-pressed={item.id === selectedId} onClick={() => onSelect(item.id)}>
                    {item.title}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
