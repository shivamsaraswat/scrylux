import { TYPE_LABELS, type ElementRecord } from '@scrylux/core';
import { useDiagramEditor } from './DiagramEditorProvider.js';
import { openThreatsText } from './flow.js';

// What a screen reader is told when one element is selected (spec FR-026): what it is and what it is called,
// and where it is, which for a node is its trust boundary and for a flow its two ends. Empty for no selection
// and for several, which are announced by the usual selection count instead. Open threats are announced with it.
export function describeSelection(
  elements: readonly ElementRecord[],
  selectedIds: readonly string[],
  counts: ReadonlyMap<string, number> = new Map(),
): string {
  const [id, ...more] = selectedIds;
  if (id === undefined || more.length > 0) return '';
  const byId = new Map(elements.map((element) => [element.id, element]));
  const element = byId.get(id);
  if (!element) return '';
  const name = (target: string | null): string => (target === null ? '?' : (byId.get(target)?.name ?? '?'));
  const open = counts.get(id) ?? 0;
  const withCount = (text: string): string => (open > 0 ? `${text}, ${openThreatsText(open)}` : text);
  if (element.type === 'data_flow') {
    return withCount(`${TYPE_LABELS.data_flow} ${element.name}, from ${name(element.source_element_id)} to ${name(element.target_element_id)}`);
  }
  const inside = element.parent_boundary_id === null ? undefined : byId.get(element.parent_boundary_id);
  return withCount(`${TYPE_LABELS[element.type]} ${element.name}, in ${inside ? inside.name : 'no trust boundary'}`);
}

// A live region, out of sight, that speaks the selection. The words are text, never markup.
export function SelectionAnnouncer() {
  const { elements = [], selectedIds, openThreats } = useDiagramEditor();
  return (
    <div role="status" aria-label="Selection" aria-live="polite" className="visually-hidden">
      {describeSelection(elements, selectedIds, openThreats)}
    </div>
  );
}
