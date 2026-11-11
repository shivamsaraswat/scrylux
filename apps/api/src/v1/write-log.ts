export type RecordType = 'project' | 'threat_model' | 'element' | 'threat' | 'mitigation' | 'asset' | 'assumption';
export type WriteAction = 'create' | 'update' | 'delete';

// One stdout line per successful write: who did what to which record (FR-014a). It takes ids only,
// so a name, a description, the token or the request body can never end up in the log.
export function logWrite(accountId: number, action: WriteAction, type: RecordType, id: string): void {
  console.log(JSON.stringify({ event: 'write', account_id: accountId, action, type, id }));
}

// One stdout line per generation run, after it has committed: who ran it, on which threat model, and the
// counts (FR-018). It takes ids and numbers only, so a name, a threat's text or a skipped element's id
// can never end up in the log. The threats and mitigations a run creates get no line of their own.
export function logGeneration(
  accountId: number,
  threatModelId: string,
  counts: { created: number; existing: number; newly_stale: number; no_longer_stale: number; skipped_elements: readonly string[] },
): void {
  console.log(
    JSON.stringify({
      event: 'generate',
      account_id: accountId,
      threat_model_id: threatModelId,
      created: counts.created,
      existing: counts.existing,
      newly_stale: counts.newly_stale,
      no_longer_stale: counts.no_longer_stale,
      skipped: counts.skipped_elements.length,
    }),
  );
}

// One stdout line per import, after it has committed: who ran it, into which project, which threat models it created
// and how many records and notes. It takes ids and numbers only, so a name, a file's text or a note's label can never
// end up in the log (FR-019). The records an import creates get no line of their own.
export function logImport(
  accountId: number,
  projectId: string,
  threatModelIds: readonly string[],
  counts: { elements: number; threats: number; mitigations: number; notes: number },
): void {
  console.log(
    JSON.stringify({
      event: 'import',
      account_id: accountId,
      project_id: projectId,
      threat_model_ids: threatModelIds,
      elements: counts.elements,
      threats: counts.threats,
      mitigations: counts.mitigations,
      notes: counts.notes,
    }),
  );
}

// One stdout line per decision on a draft (Phase 3 Milestone 5, FR-022): who decided, what they did, on which threat model, and how many items and
// records. It takes ids and numbers only, so a name, a statement or any text of the draft can never end up in the log.
export function logDecision(accountId: number, action: 'accept' | 'reject' | 'undecide', threatModelId: string, counts: { items: number; created: number; changed: number }): void {
  console.log(JSON.stringify({ event: 'decision', account_id: accountId, action, threat_model_id: threatModelId, items: counts.items, created: counts.created, changed: counts.changed }));
}
