import { ProjectCreateInput, ProjectUpdateInput, type ProjectRecord } from '@scrylux/core';
import { useState, type FormEvent } from 'react';
import { zodFieldErrors } from '../api/errors.js';
import { ErrorSummary } from './ErrorSummary.js';
import { FormField } from './FormField.js';
import { useSubmit } from './useSubmit.js';

interface ProjectFormProps {
  // Present when editing: only the fields that changed are sent.
  initial?: Pick<ProjectRecord, 'name' | 'description'>;
  onSubmit: (input: ProjectCreateInput | ProjectUpdateInput) => Promise<unknown>;
  onCancel: () => void;
}

const LABELS = { name: 'Name', description: 'Description' };

// Creates or edits a project. It checks with the same schemas as the API before sending, shows what the
// server rejects next to the field, and keeps what was typed after a rejection (spec FR-015).
export function ProjectForm({ initial, onSubmit, onCancel }: ProjectFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const { errors, setErrors, busy, run, formRef, summary } = useSubmit(LABELS);
  const editing = initial !== undefined;

  function onFormSubmit(event: FormEvent): void {
    event.preventDefault();
    void run(async () => {
      let parsed;
      if (initial) {
        const changed: Record<string, string> = {};
        if (name.trim() !== initial.name) changed.name = name;
        if (description.trim() !== initial.description) changed.description = description;
        if (Object.keys(changed).length === 0) {
          onCancel();
          return;
        }
        parsed = ProjectUpdateInput.safeParse(changed);
      } else {
        parsed = ProjectCreateInput.safeParse({ name, description });
      }
      if (!parsed.success) {
        setErrors(zodFieldErrors(parsed.error));
        return;
      }
      await onSubmit(parsed.data);
    });
  }

  return (
    <form ref={formRef} aria-label={editing ? 'Edit project' : 'New project'} onSubmit={onFormSubmit} noValidate>
      <ErrorSummary message={summary} />
      <FormField id="project-name" label="Name" error={errors.fields.name}>
        {(control) => <input {...control} type="text" value={name} onChange={(event) => setName(event.target.value)} />}
      </FormField>
      <FormField id="project-description" label="Description" error={errors.fields.description}>
        {(control) => (
          <textarea {...control} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
        )}
      </FormField>
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Saving…' : editing ? 'Save' : 'Create project'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
