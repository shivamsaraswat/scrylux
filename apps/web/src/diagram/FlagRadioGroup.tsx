import { FLAG_HINTS, flagLabel } from '@scrylux/core';
import type { FlagState } from './properties-model.js';

const OPTIONS: readonly { value: FlagState; text: string }[] = [
  { value: 'yes', text: 'Yes' },
  { value: 'no', text: 'No' },
  { value: 'unset', text: 'Not assessed' },
];

// One security flag, as three choices. "Not assessed" is a state of its own and not the same as "No": a
// flag nobody has looked at is not one that was ruled out (spec FR-015a).
export function FlagRadioGroup({ flag, value, onChange }: { flag: string; value: FlagState; onChange: (state: FlagState) => void }) {
  const label = flagLabel(flag);
  return (
    <div role="radiogroup" aria-label={label} className="diagram-flag">
      <span className="diagram-flag__label" aria-hidden="true">
        {label}
      </span>
      {FLAG_HINTS[flag] && <span className="muted diagram-flag__hint">{FLAG_HINTS[flag]}</span>}
      <span className="diagram-flag__options">
        {OPTIONS.map((option) => (
          <label key={option.value}>
            <input type="radio" name={`flag-${flag}`} checked={value === option.value} onChange={() => onChange(option.value)} />
            {option.text}
          </label>
        ))}
      </span>
    </div>
  );
}
