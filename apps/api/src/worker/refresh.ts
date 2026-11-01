import { loadChunkTexts, loadWorkSource, refreshCommit } from '../sources/commit.js';
import { currentSourceConfig } from '../sources/config.js';
import { embedAll } from './embed-all.js';
import type { Kind, KindOutcome } from './kinds.js';
import { RunStopped } from './stop.js';

// The job kind that refreshes the embeddings of a ready source (Phase 3 Milestone 3, FR-034, FR-057): it embeds the chunks that
// are stored, in order, and the commit replaces every chunk's embedding and the source's model and dimension. It never reads
// the original, which is gone once the source is ready, and it changes no chunk's identifier or text.
export const refreshEmbeddings: Kind = {
  async run(context): Promise<KindOutcome> {
    if (context.llmConfig.embedding === null) return { result: {}, failure: { category: 'not_configured' } };
    const id = context.job.input.source_id;
    const source = typeof id === 'string' ? await loadWorkSource(context.db, id) : undefined;
    // A source that is gone, or not ready, has nothing to refresh: the job ends as cancelled and writes nothing.
    if (source === undefined || source.readyAt === null) throw new RunStopped(context.stopReason() ?? 'cancelled');

    const chunks = await loadChunkTexts(context.db, source.id);
    const embedded = await embedAll(context, chunks.map((chunk) => chunk.text));
    if (!embedded.ok) return { result: {}, failure: { category: embedded.category } };
    return {
      result: { chunks: chunks.length, pages_without_text: null },
      commit: refreshCommit(source.id, { chunkIds: chunks.map((chunk) => chunk.id), vectors: embedded.vectors, model: embedded.model, dimension: embedded.dimension }, currentSourceConfig().documentSpaceBytes),
    };
  },
};
