import {
  IMPACTS,
  LIKELIHOODS,
  STRIDE_CATEGORIES,
  THREAT_STATUSES,
  ThreatCreateInput,
  ThreatUpdateInput,
  needsReason,
  type ElementRecord,
  type Impact,
  type Likelihood,
  type MitigationRecord,
  type StrideCategory,
  type ThreatRecord,
  type ThreatStatus,
} from '@scrylux/core';
import { useState, type FormEvent } from 'react';
import { zodFieldErrors } from '../api/errors.js';
import { ElementOptions } from './ElementOptions.js';
import { ErrorSummary } from './ErrorSummary.js';
import { FormField } from './FormField.js';
import { useSubmit } from './useSubmit.js';

interface ThreatFormProps {
  threatModelId: string;
  // Present when editing: only the fields that changed are sent.
  initial?: ThreatRecord;
  // The mitigations of the threat being edited. With them, a move to mitigated is refused here when none is
  // implemented or verified, as the server would (spec FR-003); without them the server decides.
  mitigations?: readonly MitigationRecord[];
  // The elements of the threat model, for the Element choice (spec FR-018).
  elements?: readonly ElementRecord[];
  // The element a new threat starts on, when the form is opened for one (the diagram's panel).
  presetElementId?: string;
  onSubmit: (input: ThreatCreateInput | ThreatUpdateInput) => Promise<unknown>;
  onCancel: () => void;
}

// In the order the form shows them, which is the order a failure is announced and focused in.
const LABELS = {
  title: 'Title',
  element_id: 'Element',
  category: 'Category',
  likelihood: 'Likelihood',
  impact: 'Impact',
  status: 'Status',
  status_reason: 'Reason',
  description: 'Description',
};
const MITIGATE_FIRST = 'Mark one of its mitigations implemented or verified first.';
const label = (value: string): string => value.replace('_', ' ');

// Creates or edits a threat. Threats made here are always origin "manual": the form offers no other origin and
// never sends one on an edit. Risk is derived by the server and shown, never edited (spec FR-011, FR-012). A new
// threat cannot be mitigated, so the add form does not offer it; accepted and not applicable ask for the reason
// (FR-003, FR-004). A manual threat is linked to an element, or to none; a generated threat's element is shown and
// cannot be changed (FR-018).
export function ThreatForm({ threatModelId, initial, mitigations, elements = [], presetElementId, onSubmit, onCancel }: ThreatFormProps) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [category, setCategory] = useState<StrideCategory | ''>(initial?.category ?? '');
  const [likelihood, setLikelihood] = useState<Likelihood | ''>(initial?.likelihood ?? '');
  const [impact, setImpact] = useState<Impact | ''>(initial?.impact ?? '');
  const [status, setStatus] = useState<ThreatStatus>(initial?.status ?? 'open');
  const [reason, setReason] = useState(initial?.status_reason ?? '');
  // '' is no element: a model-level threat.
  const [elementId, setElementId] = useState(initial?.element_id ?? presetElementId ?? '');
  const { errors, setErrors, busy, run, formRef, summary } = useSubmit(LABELS);
  const editing = initial !== undefined;
  const generated = initial?.origin === 'rule';
  const statuses = editing ? THREAT_STATUSES : THREAT_STATUSES.filter((value) => value !== 'mitigated');
  // The add form and an edit form can be open together, so each field's id carries the threat's own id.
  const idPrefix = `threat-${initial?.id ?? 'new'}`;

  function onFormSubmit(event: FormEvent): void {
    event.preventDefault();
    void run(async () => {
      if (initial) {
        const changed: Record<string, string | null> = {};
        if (title.trim() !== initial.title) changed.title = title;
        // A generated threat's element is never sent: the database would refuse it, and the form does not offer it.
        if (!generated && elementId !== (initial.element_id ?? '')) changed.element_id = elementId === '' ? null : elementId;
        if (description.trim() !== initial.description) changed.description = description;
        if (category !== initial.category) changed.category = category;
        if (likelihood !== initial.likelihood) changed.likelihood = likelihood;
        if (impact !== initial.impact) changed.impact = impact;
        if (status !== initial.status) changed.status = status;
        // A reason travels with the decision it explains. A blank one is left for the schema to refuse: "required"
        // when the status changes, "must not be empty" when it was cleared. Never sent for a status that takes none.
        if (needsReason(status)) {
          const filled = reason.trim() !== '';
          if (status !== initial.status ? filled : reason.trim() !== (initial.status_reason ?? '')) changed.status_reason = reason;
        }
        if (changed.status === 'mitigated' && mitigations && !mitigations.some((m) => m.status === 'implemented' || m.status === 'verified')) {
          setErrors({ fields: { status: MITIGATE_FIRST }, form: null });
          return;
        }
        if (Object.keys(changed).length === 0) {
          onCancel();
          return;
        }
        const parsed = ThreatUpdateInput.safeParse(changed);
        if (!parsed.success) {
          setErrors(zodFieldErrors(parsed.error));
          return;
        }
        await onSubmit(parsed.data);
        return;
      }

      const parsed = ThreatCreateInput.safeParse({
        threat_model_id: threatModelId,
        element_id: elementId === '' ? null : elementId,
        category: category || undefined,
        title,
        description,
        likelihood: likelihood || undefined,
        impact: impact || undefined,
        status,
        status_reason: needsReason(status) && reason.trim() !== '' ? reason : null,
        origin: 'manual',
      });
      // An unmade choice gets a plain message instead of the schema's "invalid option".
      const missing: Record<string, string> = {};
      if (!category) missing.category = 'Choose a category';
      if (!likelihood) missing.likelihood = 'Choose a likelihood';
      if (!impact) missing.impact = 'Choose an impact';
      if (!parsed.success || Object.keys(missing).length > 0) {
        setErrors({ fields: { ...(parsed.success ? {} : zodFieldErrors(parsed.error).fields), ...missing }, form: null });
        return;
      }
      await onSubmit(parsed.data);
    });
  }

  return (
    <form ref={formRef} aria-label={editing ? 'Edit threat' : 'Add threat'} onSubmit={onFormSubmit} noValidate>
      <ErrorSummary message={summary} />
      <FormField id={`${idPrefix}-title`} label="Title" error={errors.fields.title}>
        {(control) => <input {...control} type="text" value={title} onChange={(event) => setTitle(event.target.value)} />}
      </FormField>
      {generated ? (
        <p>
          Element: <span>{elements.find((candidate) => candidate.id === initial?.element_id)?.name ?? '—'}</span>
        </p>
      ) : (
        <FormField id={`${idPrefix}-element`} label="Element" error={errors.fields.element_id}>
          {(control) => (
            <select {...control} value={elementId} onChange={(event) => setElementId(event.target.value)}>
              <option value="">None (model-level)</option>
              <ElementOptions elements={elements} />
            </select>
          )}
        </FormField>
      )}
      <FormField id={`${idPrefix}-category`} label="Category" error={errors.fields.category}>
        {(control) => (
          <select {...control} value={category} onChange={(event) => setCategory(event.target.value as StrideCategory | '')}>
            <option value="">Select…</option>
            {STRIDE_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField id={`${idPrefix}-likelihood`} label="Likelihood" error={errors.fields.likelihood}>
        {(control) => (
          <select {...control} value={likelihood} onChange={(event) => setLikelihood(event.target.value as Likelihood | '')}>
            <option value="">Select…</option>
            {LIKELIHOODS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField id={`${idPrefix}-impact`} label="Impact" error={errors.fields.impact}>
        {(control) => (
          <select {...control} value={impact} onChange={(event) => setImpact(event.target.value as Impact | '')}>
            <option value="">Select…</option>
            {IMPACTS.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
      </FormField>
      <FormField id={`${idPrefix}-status`} label="Status" error={errors.fields.status}>
        {(control) => (
          <select {...control} value={status} onChange={(event) => setStatus(event.target.value as ThreatStatus)}>
            {statuses.map((value) => (
              <option key={value} value={value}>
                {label(value)}
              </option>
            ))}
          </select>
        )}
      </FormField>
      {needsReason(status) && (
        <FormField id={`${idPrefix}-status-reason`} label="Reason" error={errors.fields.status_reason}>
          {(control) => <textarea {...control} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />}
        </FormField>
      )}
      <FormField id={`${idPrefix}-description`} label="Description" error={errors.fields.description}>
        {(control) => (
          <textarea {...control} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        )}
      </FormField>
      <p>
        Origin: <span>{initial?.origin ?? 'manual'}</span>
      </p>
      {initial && (
        <p>
          Risk: <span>{initial.risk}</span>
        </p>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save' : 'Add threat'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
