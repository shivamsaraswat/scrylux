import type { ThreatGenerationResult } from '@scrylux/core';
import { useState } from 'react';
import { ApiError } from '../api/errors.js';
import { useGenerateThreats } from '../api/queries.js';
import { useDiagramEditor } from '../diagram/DiagramEditorProvider.js';

// What the user is told after the app's answer is lost: the run may or may not have been stored, and
// running it again is safe because it never duplicates (spec FR-004, US1 scenario 9).
const OUTCOME_UNKNOWN =
  'The connection was lost before Scrylux answered, so the threats may or may not have been generated. Generating again is safe: it never creates duplicates.';

function failureText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status >= 400 && err.status < 500) return err.message;
    // Only the app's own 500 means the transaction rolled back. A proxy's error page is turned into
    // "Request failed" by the client, and that is an unknown outcome.
    if (err.status === 500 && err.message === 'Internal server error') return 'Generating threats failed. Nothing was saved. Try again.';
  }
  return OUTCOME_UNKNOWN;
}

function summary(result: ThreatGenerationResult, names: (id: string) => string): string {
  const { created, existing, newly_stale, no_longer_stale, skipped_elements } = result;
  const headline =
    created + existing + newly_stale === 0
      ? 'No threats to generate: no rule applies to the elements of this diagram.'
      : `Generated threats: ${created} created, ${existing} already existed (of which ${no_longer_stale} no longer stale), ${newly_stale} newly stale.`;
  if (skipped_elements.length === 0) return headline;
  return `${headline} ${skipped_elements.length} element(s) skipped because their stored properties include keys Scrylux no longer uses: ${skipped_elements.map(names).join(', ')}. Change any property of each in the diagram to clean it up, then generate again.`;
}

// The "Generate threats" action, on both tabs of the threat model page. It waits for the diagram's
// own saves first, so a run sees what the user sees (spec US1 scenario 6). Every text is rendered as
// text.
export function GenerateThreats({ threatModelId }: { threatModelId: string }) {
  const editor = useDiagramEditor();
  const generate = useGenerateThreats(threatModelId);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onClick(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      if (editor.pendingCount > 0) setMessage('Saving your diagram changes first…');
      const settled = await editor.whenSettled();
      if (settled === 'failed') {
        setMessage('Your diagram has changes that could not be saved. Save them (Retry) before generating threats.');
        return;
      }
      if (settled === 'gone') {
        setMessage('This threat model no longer exists.');
        return;
      }
      setMessage('Generating threats…');
      try {
        const names = new Map((editor.elements ?? []).map((element) => [element.id, element.name]));
        setMessage(summary(await generate.mutateAsync(), (id) => names.get(id) ?? 'an element that no longer exists'));
      } catch (err) {
        setMessage(failureText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="generate-bar">
      <button type="button" className="primary" disabled={busy} onClick={() => void onClick()}>
        Generate threats
      </button>
      <p role="status">{message}</p>
    </div>
  );
}
