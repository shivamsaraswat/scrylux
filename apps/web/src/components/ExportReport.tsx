import type { ReportFormat } from '@scrylux/core';
import { useState } from 'react';
import { download } from '../api/download.js';
import { ApiError, isGone } from '../api/errors.js';
import { useDiagramEditor } from '../diagram/DiagramEditorProvider.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { ErrorSummary } from './ErrorSummary.js';

// The download buttons for a threat model's report (contracts/web-ui.md; spec FR-001, FR-017). The server makes the
// document; this asks for it with the bearer token, as any API client would, and hands the body to the browser as a
// file. Nothing is kept: the document is not cached, stored or put in an address.

// Typed by core's list of formats, so a format the API gains is a type error here until it has a button.
const FORMATS: { format: ReportFormat; label: string; extension: string }[] = [
  { format: 'markdown', label: 'Download Markdown report', extension: 'md' },
  { format: 'html', label: 'Download HTML report (print or save as PDF)', extension: 'html' },
];

async function save(threatModelId: string, { format, extension }: { format: ReportFormat; extension: string }): Promise<void> {
  const fallback = `threat-model-report-${new Date().toISOString().slice(0, 10)}.${extension}`;
  await download(`/api/v1/threat-models/${threatModelId}/report?format=${format}`, fallback);
}

function failureText(err: unknown): string {
  if (isGone(err)) return 'This threat model no longer exists.';
  if (err instanceof ApiError) return err.message;
  return 'The report could not be downloaded. Try again.';
}

export function ExportReport({ threatModelId }: { threatModelId: string }) {
  const { pendingCount } = useDiagramEditor();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<(typeof FORMATS)[number] | null>(null);

  async function run(chosen: (typeof FORMATS)[number]): Promise<void> {
    setConfirming(null);
    setBusy(true);
    setError(null);
    setMessage('Preparing report…');
    try {
      await save(threatModelId, chosen);
      setMessage('Report downloaded.');
    } catch (err) {
      setMessage('');
      setError(failureText(err));
    } finally {
      setBusy(false);
    }
  }

  // A report shows what the server holds, so with diagram changes still on their way the user is asked first.
  function onClick(chosen: (typeof FORMATS)[number]): void {
    if (pendingCount > 0) setConfirming(chosen);
    else void run(chosen);
  }

  return (
    <div className="report-bar" role="group" aria-label="Report">
      {FORMATS.map((chosen) => (
        <button key={chosen.format} type="button" disabled={busy} onClick={() => onClick(chosen)}>
          {chosen.label}
        </button>
      ))}
      <p role="status">{message}</p>
      <ErrorSummary message={error} />
      {confirming && (
        <ConfirmDialog
          title="Download report?"
          message="Some diagram changes aren't saved yet. The report shows only what is saved."
          confirmLabel="Download anyway"
          onConfirm={() => void run(confirming)}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
