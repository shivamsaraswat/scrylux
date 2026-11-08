import { DraftRecord, ExtractionStatus, JobRecord } from '@scrylux/core';
import { parseLlmStatus } from '@scrylux/llm';
import { kdb } from '../db.js';
import { currentExtractionConfig } from '../extract-system/config.js';
import { discardDraft, readDraft } from '../extract-system/draft.js';
import { logExtractionAction } from '../extract-system/log.js';
import { assessStart, type StartContext } from '../extract-system/start.js';
import { currentJobConfig } from '../jobs/config.js';
import { ExtractionActiveError, JobLimitError, enqueueExtraction, getJob } from '../jobs/store.js';
import { HttpError, orNotFound } from './errors.js';
import { defineOperation, type Operation } from './operation.js';

// The extraction routes (Phase 3 Milestone 4, contracts/http-api.md): start an extraction, read its status, read the draft it made and discard
// it. Any signed-in account can do all of them to any threat model: there are no roles before Phase 6, and the threat model says so (FR-068,
// FR-080). The API sends no request to a provider (M2 FR-070): it checks what a start needs and queues a job for the worker. No source name, no
// text and no text of a draft is in an error answer or a log line (SC-009).

async function requireThreatModel(id: string): Promise<void> {
  orNotFound(await kdb.selectFrom('threat_models').select('id').where('id', '=', id).executeTakeFirst(), 'Threat model');
}

/** What a start depends on, as the API sees it now: which providers are configured, the caps it would copy, and the two settings. */
function currentStartContext(): StartContext {
  const jobs = currentJobConfig();
  return { providers: parseLlmStatus(process.env), caps: { tokenCap: jobs.tokenCap, costCapUsd: jobs.costCapUsd }, extraction: currentExtractionConfig() };
}

/** A start that its checks refuse, with the fixed text that says why. */
class StartRefused extends Error {}

export const extractionOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'get',
    path: '/threat-models/:id/extraction',
    operationId: 'getExtraction',
    summary: 'The extraction panel of a threat model: its latest extraction, and whether a start would be accepted now',
    description:
      'The latest extraction job of the threat model, or null; and whether starting one is offered, with the reason it is not (a source still being ' +
      'processed, no ready source, no generation provider, embeddings out of date, a failure that would repeat). The page reads it again while an ' +
      'extraction is queued or running.',
    response: { name: 'ExtractionStatus', schema: ExtractionStatus },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      await requireThreatModel(id);
      const context = currentStartContext();
      const assessed = await assessStart(kdb, id, context);
      return {
        latest: assessed.latest === undefined ? null : (await getJob(kdb, assessed.latest.id)) ?? null,
        start: assessed.start,
        chunks_available: assessed.chunksAvailable,
        budget_chars: context.extraction.contextChars,
      };
    },
  }),
  defineOperation({
    method: 'post',
    path: '/threat-models/:id/extraction',
    operationId: 'startExtraction',
    summary: 'Start an extraction of a threat model, or start the last one again',
    description:
      'Queues a job that reads the threat model\'s ready sources and asks the generation model for a draft of the system they describe, and answers at ' +
      'once. There is no body. Starting again after a failure is the same call: it is refused when it would repeat the failure. 409: no generation ' +
      'provider is configured, an extraction is already queued or running, a source is still being processed (the answer counts them), there is no ready ' +
      'source, the embeddings are not usable for sources larger than the budget, or the last failure would repeat. 429: the account has too many jobs queued ' +
      'or running; Retry-After says how many seconds to wait. A draft that exists is replaced when the new one succeeds.',
    response: { name: 'JobRecord', schema: JobRecord },
    status: 201,
    errors: [400, 404, 409, 429],
    handler: async ({ id, accountId }) => {
      await requireThreatModel(id);
      const context = currentStartContext();
      try {
        const jobId = await kdb.transaction().execute(async (trx) => {
          const assessed = await assessStart(trx, id, context);
          if (!assessed.start.offered) throw new StartRefused(assessed.start.message);
          return enqueueExtraction(trx, { threatModelId: id, accountId }, currentJobConfig());
        });
        logExtractionAction(accountId, 'start', { threatModelId: id, jobId });
        return orNotFound(await getJob(kdb, jobId), 'Job');
      } catch (error) {
        if (error instanceof StartRefused || error instanceof ExtractionActiveError) throw new HttpError(409, error.message);
        // The limit on active jobs: nothing was queued, and nothing is logged (FR-046).
        if (error instanceof JobLimitError) throw new HttpError(429, error.message, { 'Retry-After': String(error.retryAfterSeconds) });
        throw error;
      }
    },
  }),
  defineOperation({
    method: 'get',
    path: '/threat-models/:id/draft',
    operationId: 'getDraft',
    summary: 'The draft of a threat model: what an extraction proposed, with where each item came from',
    description:
      'Every item carries its rationale and citations. A citation whose source was deleted has no chunk and no quote. The text of every item is AI-generated ' +
      'or taken from a document, and is shown as text. 404: the threat model has no draft.',
    response: { name: 'DraftRecord', schema: DraftRecord },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      const draft = await readDraft(kdb, id);
      if (draft === undefined) throw new HttpError(404, 'This threat model has no draft.');
      return draft;
    },
  }),
  defineOperation({
    method: 'delete',
    path: '/threat-models/:id/draft',
    operationId: 'discardDraft',
    summary: 'Discard the draft of a threat model',
    description: 'An extraction that is queued or running is not stopped: if it succeeds, it makes a new draft. 404: the threat model has no draft.',
    status: 204,
    errors: [400, 404],
    handler: async ({ id, accountId }) => {
      if (!(await discardDraft(kdb, id))) throw new HttpError(404, 'This threat model has no draft.');
      logExtractionAction(accountId, 'discard', { threatModelId: id });
    },
  }),
];
