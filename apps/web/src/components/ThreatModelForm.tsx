import { ThreatModelCreateInput, ThreatModelUpdateInput, type ThreatModelRecord } from '@scrylux/core';
import { useState, type FormEvent } from 'react';
import { zodFieldErrors } from '../api/errors.js';
import { ErrorSummary } from './ErrorSummary.js';
import { FormField } from './FormField.js';
import { useSubmit } from './useSubmit.js';

interface ThreatModelFormProps {
  // Creating: the project the new threat model belongs to. Editing: the current record.
  projectId?: string;
  initial?: Pick<ThreatModelRecord, 'name'>;
  onSubmit: (input: ThreatModelCreateInput | ThreatModelUpdateInput) => Promise<unknown>;
  onCancel: () => void;
}

const LABELS = { name: 'Name' };

// A threat model has a name, and nothing else to edit here. Its methodology is fixed to STRIDE, its
// status starts as draft and is changed on the threat model page, and the record has no description.
export function ThreatModelForm({ projectId, initial, onSubmit, onCancel }: ThreatModelFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const { errors, setErrors, busy, run, formRef, summary } = useSubmit(LABELS);
  const editing = initial !== undefined;

  function onFormSubmit(event: FormEvent): void {
    event.preventDefault();
    void run(async () => {
      if (initial && name.trim() === initial.name) {
        onCancel();
        return;
      }
      const parsed = initial
        ? ThreatModelUpdateInput.safeParse({ name })
        : ThreatModelCreateInput.safeParse({ project_id: projectId, name });
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error));
        return;
      }
      await onSubmit(parsed.data);
    });
  }

  return (
    <form ref={formRef} aria-label={editing ? 'Edit threat model' : 'New threat model'} onSubmit={onFormSubmit} noValidate>
      <ErrorSummary message={summary} />
      <FormField id="threat-model-name" label="Name" error={errors.fields.name}>
        {(control) => <input {...control} type="text" value={name} onChange={(event) => setName(event.target.value)} />}
      </FormField>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save' : 'Create threat model'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
