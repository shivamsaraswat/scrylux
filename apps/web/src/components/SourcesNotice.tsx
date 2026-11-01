import type { JobsStatus } from '@scrylux/core';

// The notice that text leaves the install (Phase 3 Milestone 3, FR-070 to FR-072, contracts/ui.md §1). Sources are the first content
// a provider receives, so the add forms say where it goes on every visit, and the list says so again while a hosted provider is
// configured. Everything is text: a provider's name is looked up here, and the operator's model name is never shown.

const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic',
  'openai-compatible': 'an OpenAI-compatible service',
  bedrock: 'Amazon Bedrock',
  gemini: 'Google Gemini',
};
const label = (provider: string): string => PROVIDER_LABEL[provider] ?? provider;

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
          When the AI features of later releases run, they send this text to {label(generation.provider)} outside this install.
        </p>
      )}
    </div>
  );
}
