import {
  MITIGATION_STATUSES,
  MitigationCreateInput,
  MitigationUpdateInput,
  type MitigationRecord,
  type MitigationStatus,
} from '@scrylux/core';
import { useState, type FormEvent } from 'react';
import { zodFieldErrors } from '../api/errors.js';
import { ErrorSummary } from './ErrorSummary.js';
import { FormField } from './FormField.js';
import { useSubmit } from './useSubmit.js';

interface MitigationFormProps {
  threatId: string;
  // Present when editing: only the fields that changed are sent.
  initial?: MitigationRecord;
  onSubmit: (input: MitigationCreateInput | MitigationUpdateInput) => Promise<unknown>;
  onCancel: () => void;
}

const LABELS = { description: 'Description', status: 'Status', external_ref: 'Ticket URL' };

// A mitigation: what will be done, how far along it is, and an optional ticket link. A blank ticket is
// sent as null. The server and the schema accept http(s) URLs only (spec FR-013).
export function MitigationForm({ threatId, initial, onSubmit, onCancel }: MitigationFormProps) {
  const [description, setDescription] = useState(initial?.description ?? '');
  const [status, setStatus] = useState<MitigationStatus>(initial?.status ?? 'proposed');
  const [ticket, setTicket] = useState(initial?.external_ref ?? '');
  const { errors, setErrors, busy, run, formRef, summary } = useSubmit(LABELS);
  const editing = initial !== undefined;

  function onFormSubmit(event: FormEvent): void {
    event.preventDefault();
    void run(async () => {
      const externalRef = ticket.trim() === '' ? null : ticket.trim();
      let parsed;
      if (initial) {
        const changed: Record<string, string | null> = {};
        if (description.trim() !== initial.description) changed.description = description;
        if (status !== initial.status) changed.status = status;
        if (externalRef !== initial.external_ref) changed.external_ref = externalRef;
        if (Object.keys(changed).length === 0) {
          onCancel();
          return;
        }
        parsed = MitigationUpdateInput.safeParse(changed);
      } else {
        parsed = MitigationCreateInput.safeParse({ threat_id: threatId, description, status, external_ref: externalRef });
      }
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error));
        return;
      }
      await onSubmit(parsed.data);
    });
  }

  return (
    <form ref={formRef} aria-label={editing ? 'Edit mitigation' : 'Add mitigation'} onSubmit={onFormSubmit} noValidate>
      <ErrorSummary message={summary} />
      <FormField id={`mitigation-description-${initial?.id ?? threatId}`} label="Description" error={errors.fields.description}>
        {(control) => (
          <textarea {...control} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
        )}
      </FormField>
      <FormField id={`mitigation-status-${initial?.id ?? threatId}`} label="Status" error={errors.fields.status}>
        {(control) => (
          <select {...control} value={status} onChange={(event) => setStatus(event.target.value as MitigationStatus)}>
            {MITIGATION_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField id={`mitigation-ticket-${initial?.id ?? threatId}`} label="Ticket URL" error={errors.fields.external_ref}>
        {(control) => <input {...control} type="text" value={ticket} onChange={(event) => setTicket(event.target.value)} />}
      </FormField>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : 'Save mitigation'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
