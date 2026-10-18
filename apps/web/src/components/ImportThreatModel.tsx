import {
  IMPORT_MAX_BYTES,
  ImportSummary,
  detectFormat,
  nameIssues,
  type ImportFormat,
  type ImportResult,
  type NameIssue,
} from '@scrylux/core';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { apiPost } from '../api/client.js';
import { ApiError, isGone } from '../api/errors.js';
import { useImportThreatModels, useThreatModels } from '../api/queries.js';
import { ErrorSummary } from './ErrorSummary.js';
import { FormField } from './FormField.js';
import { ImportNotes } from './ImportNotes.js';

// Import a file as new threat models of a project (contracts/web-ui.md; spec FR-006, FR-006b, FR-007, FR-013a, FR-016).
// The file is read here, recognised, and sent to the check operation, which creates nothing. The preview shows what
// would be created and lets the user rename it; only then is the import sent. Name problems are worked out in the
// browser with core's `nameIssues`, the function the server uses, so editing a name never sends the file again.

// Typed by core's list of formats, so a format the API gains is a type error here until it has a label.
const FORMAT_LABELS: Record<ImportFormat, string> = {
  scrylux: 'Scrylux file',
  otm: 'OTM file',
  'threat-dragon': 'Threat Dragon file',
};

const READS =
  'Scrylux imports Scrylux files (version 1), OTM 0.2.0 files in JSON, and Threat Dragon version 2 files.';
const NOT_JSON = `This file isn't JSON. ${READS}`;
const NOT_RECOGNISED = `This file isn't in a format Scrylux reads. ${READS}`;
const THREAT_DRAGON_V1 = 'This is a Threat Dragon version 1 file. Open and save it in Threat Dragon 2, which converts it, then import it here.';
const TOO_LARGE = `This file is larger than ${IMPORT_MAX_BYTES / (1024 * 1024)} MiB, the most Scrylux can import.`;

const NAME_ISSUE_TEXT: Record<NameIssue, string> = {
  taken: 'A threat model with this name already exists in this project.',
  duplicate: 'Another threat model in this file has the same name.',
  empty: 'Enter a name.',
  too_long: 'Use at most 200 characters.',
};

const statusLabel = (status: string): string => status.replace('_', ' ');

// What the import refused for a name: `names.<n>: …` (or `threat_model.name: …` for a file of one model).
const NAME_REFUSAL = /^(?:names\.(\d+)|threat_model\.name): /;

interface Loaded {
  format: ImportFormat;
  file: Record<string, unknown>;
}

type Phase = 'closed' | 'choose' | 'checking' | 'refused' | 'preview' | 'importing' | 'done';

export function ImportThreatModel({ projectId }: { projectId: string }) {
  const navigate = useNavigate();
  const existing = useThreatModels(projectId);
  const runImport = useImportThreatModels(projectId);
  const [phase, setPhase] = useState<Phase>('closed');
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [names, setNames] = useState<string[]>([]);
  // Names the server refused as taken since the user last edited them.
  const [serverTaken, setServerTaken] = useState<ReadonlySet<number>>(new Set());
  // The file stays out of state: it can be tens of megabytes, and nothing renders from it.
  const loaded = useRef<Loaded | null>(null);
  const [format, setFormat] = useState<ImportFormat | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);

  // What the user is told next takes the focus: the preview, the result, and, once the panel is closed, its status line.
  useEffect(() => {
    if (phase === 'preview' || phase === 'done') heading.current?.focus();
    else if (phase === 'closed' && status !== '') statusLine.current?.focus();
  }, [phase, status]);

  function close(): void {
    loaded.current = null;
    setFormat(null);
    setPhase('closed');
    setSummary(null);
    setResult(null);
    setNames([]);
    setProblem(null);
    setServerTaken(new Set());
  }

  function chooseAgain(): void {
    loaded.current = null;
    setFormat(null);
    setSummary(null);
    setProblem(null);
    setStatus('');
    setPhase('choose');
  }

  async function onFile(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    setProblem(null);
    // Checked before the file is read: a file over the limit is never loaded into memory (research #14).
    if (file.size > IMPORT_MAX_BYTES) {
      setProblem(TOO_LARGE);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setProblem(NOT_JSON);
      return;
    }
    const detected = detectFormat(parsed);
    if (detected.format === null) {
      setProblem(detected.reason === 'threat-dragon-v1' ? THREAT_DRAGON_V1 : NOT_RECOGNISED);
      return;
    }
    const supported: ImportFormat = detected.format;
    const body = { format: supported, file: parsed as Record<string, unknown> };
    loaded.current = body;
    setFormat(supported);
    setStatus(`Checking ${FORMAT_LABELS[supported]}…`);
    setPhase('checking');
    try {
      const checked = await apiPost(`/api/v1/projects/${projectId}/imports/check`, ImportSummary, body);
      setSummary(checked);
      setNames(checked.models.map((model) => model.name));
      setServerTaken(new Set());
      setStatus('');
      setPhase('preview');
    } catch (err) {
      loaded.current = null;
      setFormat(null);
      setStatus('');
      setProblem(isGone(err) ? 'This project no longer exists.' : err instanceof ApiError ? err.message : 'The file could not be checked. Try again.');
      // A refusal has its own screen: what was wrong, and a way to choose another file.
      setPhase('refused');
    }
  }

  const known = existing.data?.map((model) => model.name) ?? null;
  const computed = known === null ? null : nameIssues(names, known);
  const issueOf = (index: number): NameIssue | null =>
    serverTaken.has(index) ? 'taken' : computed !== null ? (computed[index] ?? null) : (summary?.models[index]?.name_issue ?? null);
  const anyIssue = names.some((_name, index) => issueOf(index) !== null);

  function rename(index: number, value: string): void {
    setNames((current) => current.map((name, at) => (at === index ? value : name)));
    setServerTaken((current) => new Set([...current].filter((at) => at !== index)));
  }

  async function onImport(): Promise<void> {
    const body = loaded.current;
    if (body === null) return;
    setProblem(null);
    setStatus('Importing…');
    setPhase('importing');
    try {
      const imported = await runImport.mutateAsync({ ...body, names });
      setStatus('');
      // One threat model: the user is taken to it, and it shows what the import left out from the summary handed over here
      // (FR-013a, FR-016). Several: the user cannot be taken to all of them, so what was left out is shown here, with a link
      // to each, and with nothing to tell the project page lists them.
      const first = imported.threat_models[0];
      if (imported.threat_models.length === 1 && first !== undefined) {
        void navigate(
          `/threat-models/${first.id}`,
          imported.summary.notes.length > 0 ? { state: { importSummary: imported.summary } } : undefined,
        );
        return;
      }
      if (imported.summary.notes.length > 0) {
        setResult(imported);
        setPhase('done');
        return;
      }
      close();
      setStatus(created(imported.threat_models.length));
    } catch (err) {
      setStatus('');
      setPhase('preview');
      const message = err instanceof ApiError ? err.message : '';
      const named = NAME_REFUSAL.exec(message);
      if (err instanceof ApiError && err.status === 409 && named) {
        setServerTaken(new Set([Number(named[1] ?? 0)]));
      } else if (isGone(err)) {
        setProblem('This project no longer exists.');
      } else {
        setProblem(err instanceof ApiError ? message : 'The import failed. Try again.');
      }
    }
  }

  const busy = phase === 'checking' || phase === 'importing';
  const created = (count: number): string => `Imported ${count} threat model${count === 1 ? '' : 's'}.`;

  if (phase === 'closed') {
    return (
      <>
        <button type="button" onClick={() => setPhase('choose')}>
          Import threat model
        </button>
        <p role="status" tabIndex={-1} ref={statusLine}>
          {status}
        </p>
      </>
    );
  }

  return (
    <section aria-label="Import threat model">
      <h3>Import threat model</h3>
      {(phase === 'choose' || phase === 'checking') && (
        <FormField id="import-file" label="File to import">
          {(control) => (
            <input
              {...control}
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(event) => void onFile(event.target.files?.[0])}
            />
          )}
        </FormField>
      )}
      <p role="status">{status}</p>
      <ErrorSummary message={phase === 'refused' ? null : problem} />
      {phase === 'refused' && (
        <div>
          <h4>This file can&apos;t be imported</h4>
          <p>{problem}</p>
          <button type="button" onClick={chooseAgain}>
            Choose another file
          </button>
        </div>
      )}
      {phase === 'done' && result !== null && (
        <div>
          <h4 ref={heading} tabIndex={-1}>
            Imported
          </h4>
          {result.threat_models.map((model, index) => {
            const counts = result.summary.models[index];
            return (
              <p key={model.id}>
                {model.name}: {counts?.elements ?? 0} elements, {counts?.threats ?? 0} threats, {counts?.mitigations ?? 0} mitigations.{' '}
                <Link to={`/threat-models/${model.id}`}>Open {model.name}</Link>
              </p>
            );
          })}
          <p>{result.summary.notes.length} parts of this file weren&apos;t carried over or were changed to fit.</p>
          <ImportNotes notes={result.summary.notes} />
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => {
                const count = result.threat_models.length;
                close();
                setStatus(created(count));
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}
      {(phase === 'preview' || phase === 'importing') && summary !== null && format !== null && (
        <div>
          <h4 ref={heading} tabIndex={-1}>
            Ready to import
          </h4>
          <p>{FORMAT_LABELS[format]}</p>
          {summary.models.map((model, index) => {
            const issue = issueOf(index);
            return (
              <div key={index}>
                <FormField id={`import-name-${index}`} label={`Name of threat model ${index + 1}`} error={issue === null ? null : NAME_ISSUE_TEXT[issue]}>
                  {(control) => (
                    <input
                      {...control}
                      type="text"
                      value={names[index] ?? ''}
                      disabled={phase === 'importing'}
                      onChange={(event) => rename(index, event.target.value)}
                    />
                  )}
                </FormField>
                <p>
                  Status {statusLabel(model.status)}: {model.elements} elements, {model.threats} threats, {model.mitigations} mitigations
                </p>
              </div>
            );
          })}
          {summary.notes.length === 0 ? (
            <p>Everything in this file will be imported.</p>
          ) : (
            <>
              <p>{summary.notes.length} parts of this file won&apos;t be carried over or were changed to fit.</p>
              <ImportNotes notes={summary.notes} />
            </>
          )}
          <div className="actions">
            <button type="button" className="primary" disabled={anyIssue || busy} onClick={() => void onImport()}>
              Import
            </button>
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {(phase === 'choose' || phase === 'checking') && (
        <button type="button" disabled={busy} onClick={close}>
          Cancel
        </button>
      )}
    </section>
  );
}
