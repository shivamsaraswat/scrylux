// One line for each thing a person does to a threat model's extraction or draft (Phase 3 Milestone 4, FR-065): who, what, which threat
// model, and which job. Never a source's name or text, a chunk, a prompt, an answer or any text of the draft (Principle IV). stdout only.

export type ExtractionAction = 'start' | 'discard';

export function logExtractionAction(accountId: number, action: ExtractionAction, line: { threatModelId: string; jobId?: string }): void {
  console.log(
    JSON.stringify({
      event: 'extraction',
      action,
      account_id: accountId,
      threat_model_id: line.threatModelId,
      ...(line.jobId === undefined ? {} : { job_id: line.jobId }),
    }),
  );
}
