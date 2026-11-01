import { codePointLength, decodeUtf8 } from '../sources/text.js';
import { chunkDocument, type DocumentModel } from '../sources/chunk.js';
import { documentFromBlocks, documentFromText } from '../sources/document.js';
import { ingestCommit, loadWorkSource } from '../sources/commit.js';
import { currentSourceConfig } from '../sources/config.js';
import { ExtractAborted, extractDocument } from '../extract/run.js';
import { StorageUnavailable, parseOriginalKey } from '../storage/index.js';
import { storage } from '../storage/instance.js';
import { embedAll } from './embed-all.js';
import type { Kind, KindOutcome, RunContext } from './kinds.js';
import { RunStopped } from './stop.js';

// The job kind that ingests a source (Phase 3 Milestone 3, FR-040, contracts/worker.md): read its original from storage,
// extract the text, split it into chunks, embed them, and hand the whole set to the commit that writes it with the job's end.
// The steps are extract, chunk and embed, and a person sees which one it is on.

const fail = (category: NonNullable<KindOutcome['failure']>['category'], detail?: NonNullable<KindOutcome['failure']>['detail']): KindOutcome => ({
  result: {},
  failure: { category, ...(detail === undefined ? {} : { detail }) },
});

/** The source this job works on: a source that is gone, or already ready, ends the job as cancelled with nothing written. */
async function sourceOf(context: RunContext) {
  const id = context.job.input.source_id;
  if (typeof id !== 'string') return undefined;
  const source = await loadWorkSource(context.db, id);
  if (source === undefined || source.readyAt !== null || source.originalKey === null) throw new RunStopped(context.stopReason() ?? 'cancelled');
  return source;
}

export const ingestSource: Kind = {
  async run(context) {
    // Configured when it was queued, perhaps no longer: the job then ends at once, without reading anything.
    if (context.llmConfig.embedding === null) return fail('not_configured');
    const source = await sourceOf(context);
    if (source === undefined || source.originalKey === null) return fail('job_error');
    const config = currentSourceConfig();

    await context.progress({ step: 'extract' });
    const key = parseOriginalKey(source.originalKey);
    if (key === undefined) return fail('job_error');
    let bytes: Uint8Array;
    try {
      bytes = await storage().get(key);
    } catch (error) {
      if (error instanceof StorageUnavailable) return fail('storage_unavailable');
      throw error;
    }

    let model: DocumentModel;
    let pagesWithoutText: number | null = null;
    if (source.type === 'pdf' || source.type === 'docx') {
      let extracted;
      try {
        extracted = await extractDocument({
          type: source.type,
          bytes,
          signal: context.signal,
          limits: { maxPages: config.extractMaxPages, unpackedBytes: config.extractUnpackedBytes, memoryMb: config.extractMemoryMb, timeLimitMs: config.extractTimeLimitMs },
        });
      } catch (error) {
        // The run was stopped while the child was reading: the stop is the run's to explain.
        if (error instanceof ExtractAborted) throw new RunStopped(context.stopReason() ?? 'cancelled');
        throw error;
      }
      if (!extracted.ok) return fail(extracted.category, extracted.detail);
      model = documentFromBlocks(source.type, extracted.blocks);
      pagesWithoutText = extracted.pagesWithoutText;
    } else {
      let raw: string;
      try {
        raw = decodeUtf8(bytes);
      } catch {
        return fail('damaged');
      }
      model = documentFromText(source.type, raw);
    }

    const textChars = codePointLength(model.text);
    if (textChars > config.maxChars) return fail('too_large', 'chars');
    if (!/\S/.test(model.text)) return fail('no_text_found');
    const textBytes = Buffer.byteLength(model.text, 'utf8');

    await context.progress({ step: 'chunk' });
    const chunks = chunkDocument(model);

    const embedded = await embedAll(context, chunks.map((chunk) => chunk.text));
    if (!embedded.ok) return fail(embedded.category);

    return {
      // Counts only, never text (FR-051).
      result: { chunks: chunks.length, pages_without_text: pagesWithoutText },
      commit: ingestCommit(source.id, { chunks, vectors: embedded.vectors, model: embedded.model, dimension: embedded.dimension, textBytes, textChars, pagesWithoutText }, config.documentSpaceBytes),
      // The commit cleared the source's original_key; the file itself goes now (FR-057).
      afterCommit: () => storage().delete(key),
    };
  },
};
