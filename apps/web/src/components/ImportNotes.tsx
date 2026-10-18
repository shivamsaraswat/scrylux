import type { ImportNote } from '@scrylux/core';
import { NOTE_HEADINGS, groupNotes, noteDetail } from './import-notes.js';

// Everything an import leaves out or changes, grouped by kind (FR-016). Names and places come from the file, so they are
// shown as text, and a place only inside <code>.
export function ImportNotes({ notes }: { notes: readonly ImportNote[] }) {
  return (
    <section aria-label="Not carried over">
      <ul>
        {groupNotes(notes).map(({ kind, items }) => (
          <li key={kind}>
            <h5>{NOTE_HEADINGS[kind]}</h5>
            <ul>
              {items.map((item, index) => {
                const detail = noteDetail(item);
                return (
                  <li key={`${item.path}-${index}`}>
                    {item.label ?? 'Unnamed'}
                    {detail !== null && <> — {detail}</>} <code>{item.path}</code>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
