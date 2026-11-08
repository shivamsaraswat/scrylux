import { DraftAnswer, type ExtractionResult, type JobFailureCategory } from '@scrylux/core';
import { requestSize } from '@scrylux/llm';
import { sql } from 'kysely';
import { checksFor } from '../extract-system/checks.js';
import { buildContent } from '../extract-system/content.js';
import { currentExtractionConfig } from '../extract-system/config.js';
import { draftCommit } from '../extract-system/draft.js';
import { fillBudget } from '../extract-system/fill.js';
import { loadChunks, loadFirstChunks, loadSourceFacts, readyFacts, type LoadedChunk } from '../extract-system/load.js';
import { mapAnswer } from '../extract-system/map.js';
import { choosePath, staleEmbeddings } from '../extract-system/path.js';
import { loadExtractionPrompt } from '../extract-system/prompt.js';
import { rankChunks } from '../extract-system/retrieve.js';
import type { Kind, KindOutcome, RunContext } from './kinds.js';
import { RunStopped } from './stop.js';

// The job kind that extracts a system (Phase 3 Milestone 4, FR-040, contracts/worker.md, research #1): choose the chunks to read, ask the
// generation model for a draft, check the answer and hand it to the commit that stores it with the job's end. The steps are select,
// generate and store, and a person sees which one it is on. It never reads the threat model's elements, threats or mitigations, and
// never writes them (FR-020, FR-050); the model is offered no tool (FR-037). What it keeps of its run is counts and two settings, never a
// name, a text, a label or a reference (FR-065).

const NONE = { elements: 0, assets: 0, assumptions: 0 };

/** A run that ends in a failure. The result is the whole record of what the run did, because the retry rules read its settings (FR-045). */
const fail = (category: JobFailureCategory, result: ExtractionResult | Record<string, never> = {}): KindOutcome => ({ result, failure: { category } });

/** The threat model this job belongs to: a job row whose threat model is gone has been deleted with it, and the run is over. */
async function threatModelOf(context: RunContext): Promise<string> {
  const { rows } = await sql<{ threat_model_id: string | null }>`SELECT threat_model_id FROM jobs WHERE id = ${context.job.id}::uuid`.execute(context.db);
  const id = rows[0]?.threat_model_id;
  if (id === null || id === undefined) throw new RunStopped(context.stopReason() ?? 'cancelled');
  return id;
}

export const extractSystem: Kind = {
  async run(context) {
    // Configured when it was queued, perhaps no longer: the job then ends at once, without reading anything.
    const generation = context.llmConfig.generation;
    if (generation === null) return fail('not_configured');
    const threatModelId = await threatModelOf(context);
    const config = currentExtractionConfig();
    const prompt = loadExtractionPrompt();

    // ---- select ----
    await context.progress({ step: 'select' });
    const facts = await loadSourceFacts(context.db, threatModelId);
    const ready = readyFacts(facts);
    if (ready.length === 0) return fail('no_ready_source');
    const readyIds = ready.map((source) => source.id);
    const sourceOrder = new Map(readyIds.map((id, index) => [id, index]));
    const path = choosePath(ready, config.contextChars);
    const chunksAvailable = ready.reduce((sum, source) => sum + source.chunkCount, 0);

    let chunks: LoadedChunk[];
    let chunksRead = 0;
    const resultFor = (items: ExtractionResult['items'] = NONE): ExtractionResult => ({
      path,
      chunks_read: chunksRead,
      chunks_available: chunksAvailable,
      sources_read: ready.length,
      sources_left_out: facts.length - ready.length,
      items,
      context_chars: config.contextChars,
      max_output_tokens: config.maxOutputTokens,
    });

    if (path === 'whole') {
      chunks = await loadChunks(context.db, readyIds);
    } else {
      // Large sources are read in part, by the chunks nearest to a system model. That compares embeddings of one model and one size only
      // (M3 FR-032), so every source must have the configured model's (FR-015).
      const embedding = context.llmConfig.embedding;
      if (embedding === null) return fail('not_configured');
      if (staleEmbeddings(ready, { model: embedding.model }).length > 0) return fail('embeddings_out_of_date');
      await context.beforeRequest({ operation: 'embed', inputChars: prompt.queries.reduce((sum, query) => sum + query.length, 0) });
      // The queries are Scrylux's own fixed text and hold no user content (FR-071).
      const embedded = await context.llm.embed({ texts: prompt.queries, signal: context.signal });
      if (embedded.usage.provider !== null) await context.record(embedded.usage);
      if (!embedded.ok) {
        if (embedded.failure.category === 'cancelled') throw new RunStopped(context.stopReason() ?? 'cancelled');
        return fail(embedded.failure.category);
      }
      if (ready.some((source) => source.embeddingDimension !== embedded.dimension)) return fail('embeddings_out_of_date');
      const ranked = await rankChunks(context.db, readyIds, embedded.vectors, sourceOrder);
      const seeds = (await loadFirstChunks(context.db, readyIds)).map((seed) => ({ id: seed.id, sourceOrder: seed.sourceOrder, position: seed.position, chars: seed.chars }));
      const chosen = fillBudget({ seeds, ranked, budgetChars: config.contextChars });
      chunks = await loadChunks(context.db, readyIds, chosen.map((candidate) => candidate.id));
    }
    chunksRead = chunks.length;
    // What the run has done so far is kept however it ends, so that a cancel or a cap still leaves its counts (FR-092 of Milestone 2).
    context.keep(resultFor());

    // ---- generate ----
    await context.progress({ step: 'generate' });
    const { content, labels } = buildContent(chunks);
    const request = {
      // The checks that depend on this request are part of the schema attempt, so a failed one is retried with its issues (FR-035).
      schema: DraftAnswer.superRefine(checksFor(labels)),
      schemaName: 'scrylux_draft',
      instructions: prompt.instructions,
      // The only place a source's text goes: the layer's marked section for untrusted content (FR-036).
      content,
      maxOutputTokens: config.maxOutputTokens,
      attemptLimit: 3 as const,
      signal: context.signal,
    };
    await context.beforeRequest({ operation: 'generate', inputChars: requestSize(request), maxOutputTokens: config.maxOutputTokens });
    const generated = await context.llm.generate(request);
    if (generated.usage.provider !== null) await context.record(generated.usage);
    if (!generated.ok) {
      if (generated.failure.category === 'cancelled') throw new RunStopped(context.stopReason() ?? 'cancelled');
      return fail(generated.failure.category, resultFor());
    }

    // ---- store ----
    await context.progress({ step: 'store' });
    const answer = generated.value;
    const mapped = mapAnswer(answer, labels);
    return {
      result: resultFor({ elements: answer.elements.length, assets: answer.assets.length, assumptions: answer.assumptions.length }),
      commit: draftCommit({
        threatModelId,
        jobId: context.job.id,
        model: generation.model,
        promptVersion: prompt.version,
        path,
        chunksAvailable,
        sources: facts.map((source) => ({ id: source.id, read: source.status === 'ready' })),
        sent: labels,
        mapped,
        nothingFound: answer.nothing_found,
      }),
    };
  },
};
