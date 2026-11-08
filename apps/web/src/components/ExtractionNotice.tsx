import type { JobsStatus } from '@scrylux/core';
import { providerLabel } from './provider-label.js';

// The notice beside the control that starts an extraction (Phase 3 Milestone 4, FR-070, FR-071, contracts/ui.md "The Draft tab"). An
// extraction is the first thing that sends a threat model's document text to a generation model, so the page says where it goes on
// every visit, before the button can be used. With a local model it says that nothing leaves. The retrieval queries that an
// extraction may embed are fixed text of Scrylux's own and need no notice of their own (FR-071). Everything is text: a provider is
// looked up by name here, and the operator's model name is never shown.

export function ExtractionNotice({ generation }: { generation: JobsStatus['ai']['generation'] }) {
  if (generation === null) return null;
  return (
    <div role="note" className="notice" aria-label="Where the text of your sources goes">
      {generation.hosted ? (
        <p>
          Starting an extraction sends the text of this threat model’s sources to {providerLabel(generation.provider)} outside this install, to the
          generation model.
        </p>
      ) : (
        <p>Extraction runs on a local model: the text of this threat model’s sources stays in this install.</p>
      )}
    </div>
  );
}
