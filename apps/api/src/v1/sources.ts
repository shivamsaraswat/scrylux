import { ChunkPage, ChunkPageQuery, SourceFileName, SourceList, SourceRecord, SourceTextInput } from '@scrylux/core';
import { kdb } from '../db.js';
import { currentSourcesContext } from '../sources/context.js';
import { logSourceAction } from '../sources/log.js';
import { sniffPaste, sniffUpload, type SniffFailure } from '../sources/sniff.js';
import { SourceRefusal, addSource, deleteSource, getChunks, getSource, listSources, refreshSource, retrySource } from '../sources/store.js';
import { readJson, readUpload } from '../sources/upload.js';
import { HttpError, orNotFound } from './errors.js';
import { defineOperation, parseBody, type Operation } from './operation.js';

// The source routes (Phase 3 Milestone 3, contracts/http-api.md). Any signed-in account can add, read, retry, refresh and delete
// every source: there are no roles before Phase 6, and the threat model says so (FR-065, FR-080). The API reads no more of a
// file than its first bytes (sniff.ts); the worker reads the rest, in a child that holds no secret (FR-010). A name, a text and
// a chunk appear in a source's own record and nowhere else: not in an error, not in a log line (SC-008).

/** A refusal of the store, as the HTTP answer it stands for. */
async function refusals<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SourceRefusal) {
      throw new HttpError(error.status, error.message, error.retryAfterSeconds === undefined ? {} : { 'Retry-After': String(error.retryAfterSeconds) });
    }
    throw error;
  }
}

const NO_PROVIDER = 'Adding documents needs an embedding provider. Ask the operator to set EMBEDDING_PROVIDER.';

async function requireThreatModel(id: string): Promise<void> {
  orNotFound(await kdb.selectFrom('threat_models').select('id').where('id', '=', id).executeTakeFirst(), 'Threat model');
}

const SNIFF_ANSWERS: Record<SniffFailure, (name: string) => HttpError> = {
  empty: () => new HttpError(400, 'The file is empty.'),
  extension: () => new HttpError(400, 'The file name must end in .md, .txt, .pdf or .docx.'),
  mismatch: (name) => new HttpError(415, /\.pdf$/i.test(name) ? 'This file is not a PDF.' : 'This file is not a Word .docx file.'),
  ole: () => new HttpError(415, 'This is an encrypted Word file or an older .doc. Upload an unprotected .docx.'),
  not_utf8: () => new HttpError(400, 'This text file is not UTF-8. Save it as UTF-8 and upload it again.'),
  nul: () => new HttpError(400, 'This text file holds a NUL character, which a text file does not. Check that it is a text file.'),
};

const tooLarge = (maxBytes: number): HttpError => new HttpError(413, `The file is larger than ${Math.floor(maxBytes / (1024 * 1024))} MB, the most allowed.`);

// The pasted text may be twice the upload limit as JSON, because JSON escapes; the limit that counts is the text's own UTF-8 size.
const PASTE_BODY_LIMIT_DOCUMENTED = 2 * 10 * 1024 * 1024;

export const sourceOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'get',
    path: '/threat-models/:id/sources',
    operationId: 'listSources',
    summary: 'List the sources of a threat model, and the limits the add form shows',
    description: 'Oldest first by the time they were added; ties broken by id. Each source shows its status, derived from its latest ingestion job.',
    response: { name: 'SourceList', schema: SourceList },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      await requireThreatModel(id);
      return listSources(kdb, currentSourcesContext(), id);
    },
  }),
  defineOperation({
    method: 'post',
    path: '/threat-models/:id/sources',
    operationId: 'uploadSource',
    summary: 'Add a document to a threat model by uploading a file',
    description:
      'Send one file, in a multipart part named file: .md, .txt, .pdf or .docx, as large as SOURCE_MAX_MB. Answers at once with the source waiting; ' +
      'its text is read, chunked and embedded in the background. 409: no embedding provider is configured, the same content is already a source of this ' +
      'threat model, or the threat model has the most sources allowed. 429: the account has too many documents being processed; Retry-After says how long to wait. ' +
      '503: the server is reading other uploads, or storage is unavailable. 507: the install has no document space left.',
    upload: true,
    deferBody: true,
    limitConcurrentBodies: true,
    response: { name: 'SourceRecord', schema: SourceRecord },
    status: 201,
    errors: [404, 409, 429, 507],
    handler: ({ id, accountId, request }) =>
      refusals(async () => {
        const ctx = currentSourcesContext();
        // Before any of the file is read: a threat model that is not there, and a feature that is not configured.
        await requireThreatModel(id);
        if (ctx.embeddingModel === null) throw new HttpError(409, NO_PROVIDER);
        const file = await readUpload(request, ctx.config.maxUploadBytes);
        const name = SourceFileName.safeParse(file.name);
        if (!name.success) throw new HttpError(400, name.error.issues[0]?.message ?? 'The file name is not valid.');
        const sniffed = sniffUpload(name.data, file.bytes);
        if (!sniffed.ok) throw SNIFF_ANSWERS[sniffed.reason](name.data);
        const source = await addSource(kdb, ctx, { threatModelId: id, accountId, name: name.data, type: sniffed.type, bytes: file.bytes });
        logSourceAction(accountId, 'add', { id: source.id, threatModelId: id, type: source.type, sizeBytes: source.size_bytes });
        return source;
      }),
  }),
  defineOperation({
    method: 'post',
    path: '/threat-models/:id/sources/text',
    operationId: 'pasteSource',
    summary: 'Add a document to a threat model by pasting its text',
    description: 'The text is ingested as if it were an uploaded .txt file, named by its title. The same answers as the upload, apart from 415.',
    body: { name: 'SourceTextInput', schema: SourceTextInput },
    bodyLimit: PASTE_BODY_LIMIT_DOCUMENTED,
    deferBody: true,
    limitConcurrentBodies: true,
    response: { name: 'SourceRecord', schema: SourceRecord },
    status: 201,
    errors: [404, 409, 429, 507],
    handler: ({ id, accountId, request }) =>
      refusals(async () => {
        const ctx = currentSourcesContext();
        await requireThreatModel(id);
        if (ctx.embeddingModel === null) throw new HttpError(409, NO_PROVIDER);
        const input = parseBody(SourceTextInput, await readJson(request, ctx.config.maxUploadBytes * 2), false);
        const pasted = sniffPaste(input.text);
        if (!pasted.ok) throw SNIFF_ANSWERS[pasted.reason]('');
        if (pasted.bytes.length > ctx.config.maxUploadBytes) throw tooLarge(ctx.config.maxUploadBytes);
        const source = await addSource(kdb, ctx, { threatModelId: id, accountId, name: input.title, type: 'text', bytes: pasted.bytes });
        logSourceAction(accountId, 'add', { id: source.id, threatModelId: id, type: source.type, sizeBytes: source.size_bytes });
        return source;
      }),
  }),
  defineOperation({
    method: 'get',
    path: '/sources/:id',
    operationId: 'getSource',
    summary: 'Get one source',
    response: { name: 'SourceRecord', schema: SourceRecord },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => orNotFound(await getSource(kdb, currentSourcesContext(), id), 'Source'),
  }),
  defineOperation({
    method: 'get',
    path: '/sources/:id/chunks',
    operationId: 'listChunks',
    summary: 'Get the chunks of a ready source, in order, a page at a time',
    description:
      'The text the source was read as, divided into its chunks, each with where it came from in the original. 409 while the source is not ready: ' +
      'no part of a set of chunks is ever served. The chunks of a ready source never change.',
    query: { name: 'ChunkPageQuery', schema: ChunkPageQuery },
    response: { name: 'ChunkPage', schema: ChunkPage },
    status: 200,
    errors: [400, 404, 409],
    handler: ({ id, query }) => refusals(async () => orNotFound(await getChunks(kdb, id, query), 'Source')),
  }),
  defineOperation({
    method: 'post',
    path: '/sources/:id/retry',
    operationId: 'retrySource',
    summary: 'Process a source that failed again',
    description:
      'Queues a new job, with the caps that are set now. 409: the source has not failed; the failure comes from the document itself; it would reach the same cap; ' +
      'the embedding model does not accept the chunk size; or no embedding provider is configured. There is no body.',
    response: { name: 'SourceRecord', schema: SourceRecord },
    status: 200,
    errors: [400, 404, 409, 429, 507],
    handler: ({ id, accountId }) =>
      refusals(async () => {
        const source = orNotFound(await retrySource(kdb, currentSourcesContext(), { sourceId: id, accountId }), 'Source');
        logSourceAction(accountId, 'retry', { id, threatModelId: source.threat_model_id, type: source.type, sizeBytes: source.size_bytes });
        return source;
      }),
  }),
  defineOperation({
    method: 'post',
    path: '/sources/:id/refresh',
    operationId: 'refreshSource',
    summary: 'Replace the embeddings of a ready source with ones from the configured model',
    description:
      'Queues a job that embeds the stored chunks again and changes no chunk. 409: the source is not ready, its embeddings are current, it is already being refreshed, ' +
      'or no embedding provider is configured. There is no body.',
    response: { name: 'SourceRecord', schema: SourceRecord },
    status: 200,
    errors: [400, 404, 409, 429, 507],
    handler: ({ id, accountId }) =>
      refusals(async () => {
        const source = orNotFound(await refreshSource(kdb, currentSourcesContext(), { sourceId: id, accountId }), 'Source');
        logSourceAction(accountId, 'refresh', { id, threatModelId: source.threat_model_id, type: source.type, sizeBytes: source.size_bytes });
        return source;
      }),
  }),
  defineOperation({
    method: 'delete',
    path: '/sources/:id',
    operationId: 'deleteSource',
    summary: 'Delete a source, its chunks and its stored original',
    description: 'Its queued and running jobs are asked to stop. If storage cannot remove the original now, it is removed later.',
    status: 204,
    errors: [400, 404],
    handler: async ({ id, accountId }) => {
      const ctx = currentSourcesContext();
      const source = orNotFound(await getSource(kdb, ctx, id), 'Source');
      orNotFound((await deleteSource(kdb, ctx, { sourceId: id, accountId })) ? true : undefined, 'Source');
      logSourceAction(accountId, 'delete', { id, threatModelId: source.threat_model_id, type: source.type, sizeBytes: source.size_bytes });
    },
  }),
];
