import {
  DESCRIPTION_MAX_LENGTH,
  NAME_MAX_LENGTH,
  STRIDE_CATEGORIES,
  TAG_MAX_LENGTH,
  TAGS_MAX_COUNT,
  type ElementType,
  type ImportNote,
  type NoteKind,
  type StrideCategory,
} from '@scrylux/core';

// Small helpers the planners of other tools' files share (research #12, #13).

export function note(path: string, kind: NoteKind, label?: string, detail?: string): ImportNote {
  return { path, kind, ...(label === undefined ? {} : { label }), ...(detail === undefined ? {} : { detail }) };
}

// Cut to the limit in code points (as @scrylux/core counts them), ending in an ellipsis, as the threat library does for
// generated text. `cut` says whether anything was lost, so the caller can add a note.
export function shorten(text: string, max: number): { text: string; cut: boolean } {
  const characters = [...text];
  if (characters.length <= max) return { text, cut: false };
  return { text: `${characters.slice(0, max - 1).join('').trimEnd()}…`, cut: true };
}

// Scrylux's tag rules applied to tags from another tool: trimmed, empty ones dropped, equal ignoring case merged (the
// first kept), each cut to the length limit, at most the count limit. Only merging, cutting and capping are reported:
// trimming and dropping a blank lose nothing.
export function normalizeTags(tags: readonly string[]): { tags: string[]; changed: boolean } {
  const seen = new Set<string>();
  const result: string[] = [];
  let changed = false;
  for (const raw of tags) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);
    const { text, cut } = shorten(trimmed, TAG_MAX_LENGTH);
    changed = changed || cut;
    result.push(text);
  }
  if (result.length > TAGS_MAX_COUNT) {
    result.length = TAGS_MAX_COUNT;
    changed = true;
  }
  return { tags: result, changed };
}

// Only a-z, lower case: how states and categories are compared, so "Not Applicable", "not-applicable" and "N/A" meet
// their words in mappings.ts.
export function letters(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z]/g, '');
}

export function matchStride(value: string): StrideCategory | null {
  const wanted = letters(value);
  if (wanted === '') return null;
  return STRIDE_CATEGORIES.find((category) => letters(category) === wanted) ?? null;
}

const PLACEHOLDERS: Record<ElementType | 'threat' | 'mitigation', string> = {
  trust_boundary: 'Unnamed trust boundary',
  external_entity: 'Unnamed external entity',
  process: 'Unnamed process',
  data_store: 'Unnamed data store',
  data_flow: 'Unnamed data flow',
  threat: 'Unnamed threat',
  mitigation: 'Unnamed mitigation',
};

export const hasText = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== '';

// What the planners of another tool's file do to make its text fit Scrylux, each saying so in the notes: a name that is
// empty becomes "Unnamed …", a name or text over the limit is shortened, and tags are normalised.
export function adapters(notes: ImportNote[]) {
  const add = (item: ImportNote): void => void notes.push(item);
  return {
    add,
    // A field of the file that Scrylux has no place for.
    field: (path: string, label: string | undefined, detail: string): void => add(note(path, 'not_imported.field', label, detail)),
    nameOf: (raw: string | null | undefined, path: string, type: ElementType | 'threat' | 'mitigation'): string => {
      const trimmed = (raw ?? '').trim();
      if (trimmed === '') {
        add(note(path, 'adjusted.unnamed'));
        return PLACEHOLDERS[type];
      }
      const { text, cut } = shorten(trimmed, NAME_MAX_LENGTH);
      if (cut) add(note(path, 'adjusted.shortened', text, 'name'));
      return text;
    },
    longText: (raw: string, path: string, label: string | undefined, field: string): string => {
      const { text, cut } = shorten(raw.trim(), DESCRIPTION_MAX_LENGTH);
      if (cut) add(note(path, 'adjusted.shortened', label, field));
      return text;
    },
    tagsOf: (tags: readonly (string | null)[] | null | undefined, path: string, label: string | undefined): string[] => {
      const { tags: kept, changed } = normalizeTags((tags ?? []).filter((tag): tag is string => typeof tag === 'string'));
      if (changed) add(note(path, 'adjusted.tags', label));
      return kept;
    },
  };
}
