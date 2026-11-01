import type { JobFailureCategory } from '@scrylux/core';
import type { RunContext } from './kinds.js';
import { RunStopped } from './stop.js';

// Embeds texts for ingestion and refresh (Phase 3 Milestone 3, FR-031, FR-040, FR-042, research #8): in batches of 64, each one
// gated by the job's caps before it is sent, each one's usage stored whether it worked or not, with the progress the person
// sees. It stops as the run stops: a request in flight is abandoned and nothing more is sent.

const BATCH = 64;

export type EmbedOutcome =
  | { ok: true; vectors: number[][]; model: string; dimension: number }
  | { ok: false; category: JobFailureCategory };

export async function embedAll(context: RunContext, texts: readonly string[]): Promise<EmbedOutcome> {
  const vectors: number[][] = [];
  let model: string | undefined;
  let dimension: number | undefined;
  await context.progress({ step: 'embed', done: 0, total: texts.length });

  for (let at = 0; at < texts.length; at += BATCH) {
    const batch = texts.slice(at, at + BATCH);
    // The gate: the most this request could use must still fit under the caps, counting every earlier request and run.
    await context.beforeRequest({ operation: 'embed', inputChars: batch.reduce((sum, text) => sum + text.length, 0) });
    const result = await context.llm.embed({ texts: batch, signal: context.signal });
    // A request that was never made has no provider to name, and no record.
    if (result.usage.provider !== null) await context.record(result.usage);

    if (!result.ok) {
      if (result.failure.category === 'cancelled') throw new RunStopped(context.stopReason() ?? 'cancelled');
      return { ok: false, category: result.failure.category };
    }
    // One model and one size for every vector of a source (FR-032), and numbers pgvector will take.
    if ((dimension !== undefined && result.dimension !== dimension) || (model !== undefined && result.model !== model)) return { ok: false, category: 'rejected' };
    if (result.vectors.length !== batch.length || result.vectors.some((vector) => vector.length !== result.dimension || !vector.every(Number.isFinite))) {
      return { ok: false, category: 'rejected' };
    }
    model = result.model;
    dimension = result.dimension;
    vectors.push(...result.vectors);
    await context.progress({ step: 'embed', done: vectors.length, total: texts.length });
  }
  return { ok: true, vectors, model: model as string, dimension: dimension as number };
}
