import type { ExportFormat } from '@scrylux/core';
import { useState } from 'react';
import { download } from '../api/download.js';
import { ApiError, isGone } from '../api/errors.js';
import { useDiagramEditor } from '../diagram/DiagramEditorProvider.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ErrorSummary } from './ErrorSummary.js';

// The download buttons for a threat model's export files (contracts/web-ui.md; spec FR-001). Like the report buttons,
// the server makes the file and this asks for it with the bearer token and hands the body to the browser. Nothing is
// kept: the file is not cached, stored or put in an address.

// Typed by core's list of formats, so a format the API gains is a type error here until it has a button.
const FORMATS: Record<ExportFormat, { label: string; extension: string }> = {
  scrylux: { label: 'Download Scrylux file', extension: 'scrylux.json' },
  otm: { label: 'Download OTM file', extension: 'otm.json' },
};
const CHOICES = (Object.keys(FORMATS) as ExportFormat[]).map((format) => ({ format, ...FORMATS[format] }));
type Choice = (typeof CHOICES)[number];

async function save(threatModelId: string, { format, extension }: Choice): Promise<void> {
  const fallback = `threat-model-${new Date().toISOString().slice(0, 10)}.${extension}`;
  await download(`/api/v1/threat-models/${threatModelId}/export?format=${format}`, fallback);
}

function failureText(err: unknown): string {
  if (isGone(err)) return 'This threat model no longer exists.';
  if (err instanceof ApiError) return err.message;
  return 'The export could not be downloaded. Try again.';
}

export function ExportModel({ threatModelId }: { threatModelId: string }) {
  const { pendingCount } = useDiagramEditor();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Choice | null>(null);

  async function run(chosen: Choice): Promise<void> {
    setConfirming(null);
    setBusy(true);
    setError(null);
    setMessage('Preparing export…');
    try {
      await save(threatModelId, chosen);
      setMessage('Export downloaded.');
    } catch (err) {
      setMessage('');
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  // An export holds what the server holds, so with diagram changes still on their way the user is asked first.
  function onClick(chosen: Choice): void {
    if (pendingCount > 0) setConfirming(chosen);
    else void run(chosen);
  }

  return (
    <div className="export-bar" role="group" aria-label="Export">
      {CHOICES.map((chosen) => (
        <button key={chosen.format} type="button" disabled={busy} onClick={() => onClick(chosen)}>
          {chosen.label}
        </button>
      ))}
      <p role="status">{message}</p>
      <ErrorSummary message={error} />
      {confirming && (
        <ConfirmDialog
          title="Download export?"
          message="Some diagram changes aren't saved yet. The export holds only what is saved."
          confirmLabel="Download anyway"
          onConfirm={() => void run(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
