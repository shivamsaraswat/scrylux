import type { SourceType } from '@scrylux/core';

// One line for each thing a person does to a source (Phase 3 Milestone 3, FR-061): who, what, which source and threat model,
// and the type and size of the source. Never its name, its text, a chunk or an embedding (Principle IV). stdout only.

export type SourceAction = 'add' | 'retry' | 'refresh' | 'delete';

export function logSourceAction(
  accountId: number,
  action: SourceAction,
  source: { id: string; threatModelId: string; type: SourceType; sizeBytes: number },
): void {
  console.log(
    JSON.stringify({
      event: 'source',
      action,
      account: accountId,
      source: source.id,
      threat_model: source.threatModelId,
      type: source.type,
      size_bytes: source.sizeBytes,
    }),
  );
}
