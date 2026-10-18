import { elementPropertiesSchema, type ElementType } from '@scrylux/core';
import { useState, type KeyboardEvent } from 'react';
import { FormField } from '../components/FormField.js';

// The technology tags of an element: free-text labels, with the limits the shared vocabulary sets
// (spec FR-016). A tag the vocabulary refuses is not added, and the reason is shown next to the field.
export function TagsEditor({ type, tags, onChange }: { type: ElementType; tags: readonly string[]; onChange: (tags: string[]) => void }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  function add(): void {
    if (text === '') return;
    const next = [...tags, text];
    const result = elementPropertiesSchema(type).safeParse({ tags: next });
    if (!result.success) {
      setError(result.error.issues[0]?.message ?? 'is not valid');
      return;
    }
    setError(null);
    setText('');
    onChange(result.data.tags ?? next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    add();
  }

  return (
    <div className="diagram-tags">
      {tags.length > 0 && (
        <ul aria-label="Technology tags">
          {tags.map((tag) => (
            <li key={tag}>
              <span>{tag}</span>
              <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => onChange(tags.filter((other) => other !== tag))}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <FormField id="diagram-element-tag" label="Add a technology tag" error={error}>
        {(control) => (
          <span className="diagram-tags__add">
            <input {...control} type="text" value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKeyDown} />
            <button type="button" onClick={add}>
              Add tag
            </button>
          </span>
        )}
      </FormField>
    </div>
  );
}
