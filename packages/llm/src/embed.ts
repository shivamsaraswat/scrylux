import type { Adapter } from './adapters/types.js';
import { defaultDeps, planRetry, raceAbort, type CallRecord, type LoopDeps } from './attempts.js';
import { AdapterError, type FailureCategory } from './errors.js';
import type { ProviderName } from './types.js';

// The embedding loop: the texts go to the provider in the batches it accepts (FR-018), one after another, with the same
// transient retries, time limit and cancellation as a structured request. One request, one result, one usage record.

export interface EmbedLoopRequest {
  provider: ProviderName;
  model: string;
  texts: readonly string[];
  /** How many texts one call takes (models.yaml). */
  batchSize: number;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
}

export type EmbedLoopOutcome =
  | { ok: true; vectors: number[][]; dimension: number }
  | { ok: false; category: FailureCategory; index?: number };

export interface EmbedLoopResult {
  outcome: EmbedLoopOutcome;
  calls: CallRecord[];
  /** One for the request, plus its transient retries; 0 when nothing was sent. */
  attempts: number;
}

type Batch = { ok: true; vectors: number[][] } | { ok: false; category: FailureCategory };

export async function runEmbed(adapter: Adapter, req: EmbedLoopRequest, deps: LoopDeps = defaultDeps): Promise<EmbedLoopResult> {
  const calls: CallRecord[] = [];
  let transientRetries = 0;

  const result = (outcome: EmbedLoopOutcome): EmbedLoopResult => ({ outcome, calls, attempts: calls.length === 0 ? 0 : 1 + transientRetries });
  const fail = (category: FailureCategory, index?: number): EmbedLoopResult =>
    result(index === undefined ? { ok: false, category } : { ok: false, category, index });

  /** One call, retried while the failure is transient and the request has retries left. */
  async function send(batch: readonly string[]): Promise<Batch> {
    for (;;) {
      if (req.signal?.aborted) return { ok: false, category: 'cancelled' };
      const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]) : AbortSignal.timeout(req.timeoutMs);
      const record: CallRecord = {
        inputChars: batch.reduce((sum, text) => sum + text.length, 0),
        outputChars: 0,
        temperature: undefined,
        answered: false,
      };
      try {
        const answer = await raceAbort(adapter.embedBatch(batch, { timeoutMs: req.timeoutMs, signal }), signal);
        record.answered = true;
        if (answer.inputTokens !== undefined) record.inputTokens = answer.inputTokens;
        calls.push(record);
        if (answer.vectors.length !== batch.length) return { ok: false, category: 'rejected' };
        return { ok: true, vectors: answer.vectors };
      } catch (error) {
        calls.push(record);
        if (req.signal?.aborted) return { ok: false, category: 'cancelled' };
        const known = error instanceof AdapterError ? error : undefined;
        const category: FailureCategory = signal.aborted ? 'provider_unavailable' : (known?.category ?? 'provider_unavailable');
        if (category !== 'rate_limited' && category !== 'provider_unavailable') return { ok: false, category };
        const plan = planRetry(transientRetries, known?.retryAfterMs, deps.random);
        if ('giveUp' in plan) return { ok: false, category: plan.category ?? category };
        transientRetries++;
        await deps.sleep(plan.waitMs, req.signal);
      }
    }
  }

  const vectors: number[][] = [];
  let dimension = 0;
  const take = (batchVectors: number[][]): FailureCategory | undefined => {
    for (const vector of batchVectors) {
      if (vector.length === 0 || (dimension !== 0 && vector.length !== dimension)) return 'rejected';
      dimension = vector.length;
      vectors.push(vector);
    }
    return undefined;
  };

  for (let start = 0; start < req.texts.length; start += req.batchSize) {
    const batch = req.texts.slice(start, start + req.batchSize);
    const sent = await send(batch);
    if (sent.ok) {
      const bad = take(sent.vectors);
      if (bad) return fail(bad);
      continue;
    }
    if (sent.category !== 'input_too_large') return fail(sent.category);
    if (batch.length === 1) return fail('input_too_large', start);

    // The batch was too large, whether because one text is or all of them together are: send the texts one at a time.
    // The text that is too long on its own is named by its position, never by its content (FR-019).
    for (const [offset, text] of batch.entries()) {
      const single = await send([text]);
      if (!single.ok) return single.category === 'input_too_large' ? fail('input_too_large', start + offset) : fail(single.category);
      const bad = take(single.vectors);
      if (bad) return fail(bad);
    }
  }
  return result({ ok: true, vectors, dimension });
}
