import { NOTE_KINDS, NOT_IMPORTED_FIELDS } from '@scrylux/core';
import { describe, expect, it } from 'vitest';
import { NOTE_HEADINGS, groupNotes, noteDetail } from './import-notes.js';

// The words of the import summary (contracts/web-ui.md): nothing an import can list is left without them.

describe('import-notes', () => {
  it('has a heading for every kind of note, each different', () => {
    expect(Object.keys(NOTE_HEADINGS).sort()).toEqual([...NOTE_KINDS].sort());
    expect(new Set(Object.values(NOTE_HEADINGS)).size).toBe(NOTE_KINDS.length);
  });

  it.each(NOT_IMPORTED_FIELDS)('has words for the field %s', (field) => {
    expect(noteDetail({ path: 'file.x', kind: 'not_imported.field', detail: field })).toMatch(/\S/);
  });

  it('says nothing more for a kind whose heading says it all, and for a field it does not know', () => {
    expect(noteDetail({ path: 'file.x', kind: 'not_imported.asset' })).toBeNull();
    expect(noteDetail({ path: 'file.x', kind: 'mapped.component_type', detail: 'process' })).toBeNull();
    expect(noteDetail({ path: 'file.x', kind: 'not_imported.field', detail: 'constructor' })).toBeNull();
  });

  it('groups the notes by kind, in the order of the kinds, keeping the file’s order within a kind', () => {
    const grouped = groupNotes([
      { path: 'b', kind: 'adjusted.layout' },
      { path: 'a', kind: 'not_imported.asset' },
      { path: 'c', kind: 'adjusted.layout' },
    ]);
    expect(grouped.map((group) => [group.kind, group.items.map((item) => item.path)])).toEqual([
      ['not_imported.asset', ['a']],
      ['adjusted.layout', ['b', 'c']],
    ]);
  });
});
