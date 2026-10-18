import { ELEMENT_TYPES, TYPE_LABELS, type ElementRecord } from '@scrylux/core';

// The elements of a threat model as the options of a select: grouped by type, each group by name. A group with no
// element is left out. Names are children, so markup in one is shown as text.
export function ElementOptions({ elements }: { elements: readonly ElementRecord[] }) {
  return (
    <>
      {ELEMENT_TYPES.map((type) => {
        const ofType = elements.filter((candidate) => candidate.type === type).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        return ofType.length === 0 ? null : (
          <optgroup key={type} label={TYPE_LABELS[type]}>
            {ofType.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </optgroup>
        );
      })}
    </>
  );
}
