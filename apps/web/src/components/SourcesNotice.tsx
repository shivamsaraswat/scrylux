import type { JobsStatus } from '@scrylux/core';
import { providerLabel } from './provider-label.js';

// The notice that text leaves the install (Phase 3 Milestone 3, FR-070 to FR-072, contracts/ui.md §1). Since Milestone 4 its generation
// sentence names the one thing that sends a source's text to generation: starting an extraction on the Draft tab (FR-072). Sources are the first content
// a provider receives, so the add forms say where it goes on every visit, and the list says so again while a hosted provider is
// configured. Everything is text: a provider's name is looked up here, and the operator's model name is never shown.

const label = providerLabel;

/** True while any configured operation sends text outside the install: the list repeats the notice then (FR-072). */
export const anyHosted = (ai: JobsStatus['ai']): boolean => ai.embedding?.hosted === true || ai.generation?.hosted === true;

export function SourcesNotice({ ai }: { ai: JobsStatus['ai'] }) {
  const embedding = ai.embedding?.hosted === true ? ai.embedding : null;
  const generation = ai.generation?.hosted === true ? ai.generation : null;
  return (
    <div role="note" className="notice" aria-label="Where the text you add goes">
      {embedding === null && generation === null && <p>Text you add here stays in this install: the configured providers run locally.</p>}
      {embedding !== null && <p>Text you add here is sent to {label(embedding.provider)} outside this install, to make its embeddings.</p>}
      {generation !== null && (
        <p>
          When you start an extraction on the Draft tab, it sends this text to {label(generation.provider)} outside this install.
        </p>
      )}
    </div>
  );
}
