import {
  THREAT_STATUSES,
  ThreatUpdateInput,
  lifecycleGap,
  needsReason,
  type MitigationRecord,
  type ThreatRecord,
  type ThreatStatus,
} from '@scrylux/core';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { writeErrorMessage } from '../api/errors.js';
import { useUpdateThreat } from '../api/queries.js';
import { ErrorSummary } from './ErrorSummary.js';
import { FormField } from './FormField.js';
import { statusControlId } from './row-focus.js';

interface StatusControlProps {
  threat: ThreatRecord;
  // This threat's own mitigations: what the mitigated rule is judged on before anything is sent.
  mitigations: readonly MitigationRecord[];
  threatModelId: string;
  // Opens the mitigations panel, when mitigated is refused for want of an implemented one.
  onOpenMitigations: () => void;
  // Called once a change has been saved and the list has been read again, so the list can see whether the row
  // still belongs in its view.
  onSaved?: () => void;
}

const MITIGATE_FIRST = 'Mark one of its mitigations implemented or verified first.';
const GAP_TEXT = { reason_missing: 'Needs a reason', no_implemented_mitigation: 'No implemented mitigation' } as const;
const label = (value: string): string => value.replace('_', ' ');

// What the reason editor is for: a move to a status that takes a reason, or a change to the reason alone.
interface Editing {
  status: ThreatStatus;
  reasonOnly: boolean;
}

// A threat's status, changed from its row (contracts/web-ui.md §1; spec FR-008). The select always shows the
// server's status: it changes only after a confirmed save. Accepting a risk and dismissing a threat are decisions,
// so choosing either opens an editor for the reason and sends nothing until it is saved (FR-004). The server
// enforces every rule (FR-007); the checks here only save a request that is certain to be refused.
export function StatusControl({ threat, mitigations, threatModelId, onOpenMitigations, onSaved }: StatusControlProps) {
  const update = useUpdateThreat(threatModelId);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [text, setText] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reasonBox = useRef<HTMLTextAreaElement>(null);
  const gap = lifecycleGap(threat, mitigations);
  const hasReason = needsReason(threat.status);

  useEffect(() => {
    if (editing) reasonBox.current?.focus();
  }, [editing]);

  async function send(change: ThreatUpdateInput): Promise<boolean> {
    setError(null);
    try {
      await update.mutateAsync({ id: threat.id, input: change });
      return true;
    } catch (err) {
      setError(writeErrorMessage(err));
      return false;
    }
  }

  function choose(next: ThreatStatus): void {
    setError(null);
    setEditing(null);
    if (next === 'open') {
      void send({ status: 'open' }).then((saved) => saved && onSaved?.());
    } else if (next === 'mitigated') {
      if (mitigations.some((m) => m.status === 'implemented' || m.status === 'verified')) {
        void send({ status: 'mitigated' }).then((saved) => saved && onSaved?.());
      } else {
        setError(MITIGATE_FIRST);
        onOpenMitigations();
      }
    } else {
      // Moving between accepted and not applicable starts from the reason already given (spec FR-005).
      open({ status: next, reasonOnly: false }, hasReason ? (threat.status_reason ?? '') : '');
    }
  }

  function open(next: Editing, start: string): void {
    setText(start);
    setFieldError(null);
    setEditing(next);
  }

  function close(): void {
    setEditing(null);
    setFieldError(null);
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!editing) return;
    const reason = text.trim();
    if (reason === '') {
      setFieldError('Give a reason');
      return;
    }
    if (editing.reasonOnly && reason === threat.status_reason) {
      close();
      return;
    }
    const parsed = ThreatUpdateInput.safeParse(
      editing.reasonOnly ? { status_reason: reason } : { status: editing.status, status_reason: reason },
    );
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? 'Give a reason');
      return;
    }
    if (await send(parsed.data)) {
      close();
      onSaved?.();
    }
  }

  const selectId = statusControlId(threat.id);
  const reasonId = `threat-reason-${threat.id}`;
  const reasonLabel =
    editing?.status === 'accepted' ? `Reason for accepting ${threat.title}` : `Reason it does not apply: ${threat.title}`;

  return (
    <div className="status-control">
      <select
        id={selectId}
        aria-label={`Status of ${threat.title}`}
        // The server's value, not the attempted one: it changes only after a refetch.
        value={threat.status}
        disabled={update.isPending}
        onChange={(event) => choose(event.target.value as ThreatStatus)}
      >
        {THREAT_STATUSES.map((value) => (
          <option key={value} value={value}>
            {label(value)}
          </option>
        ))}
      </select>
      {gap && <strong className="badge gap">{GAP_TEXT[gap]}</strong>}
      {hasReason && threat.status_reason && <p className="status-reason">{threat.status_reason}</p>}
      {hasReason && !editing && (
        <button type="button" aria-label={`Edit reason for ${threat.title}`} onClick={() => open({ status: threat.status, reasonOnly: true }, threat.status_reason ?? '')}>
          Edit reason
        </button>
      )}
      <ErrorSummary message={error} />
      {editing && (
        <form aria-label={reasonLabel} onSubmit={(event) => void save(event)} noValidate>
          <FormField id={reasonId} label={reasonLabel} error={fieldError}>
            {(control) => (
              <textarea {...control} ref={reasonBox} rows={3} value={text} onChange={(event) => setText(event.target.value)} />
            )}
          </FormField>
          <div className="actions">
            <button type="submit" className="primary" disabled={update.isPending}>
              Save
            </button>
            <button type="button" onClick={close} disabled={update.isPending}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
