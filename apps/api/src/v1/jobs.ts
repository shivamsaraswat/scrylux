import { JobCreateInput, JobDetail, JobList, JobListQuery, JobRecord, JobsStatus } from '@scrylux/core';
import { parseLlmStatus } from '@scrylux/llm';
import { kdb } from '../db.js';
import { currentJobConfig } from '../jobs/config.js';
import { CALLS_MODEL } from '../jobs/kinds.js';
import { logJobAction } from '../jobs/log.js';
import { JobFinishedError, JobLimitError, cancelJob, enqueue, getDetail, getJob, listJobs, nextAllowedAt, workerAlive } from '../jobs/store.js';
import { HttpError, orNotFound } from './errors.js';
import { defineOperation, type Operation } from './operation.js';

// The job routes (Phase 3 Milestone 2, contracts/http-api.md). Any signed-in account can see and cancel every job: there
// are no roles before Phase 6, and the threat model says so (FR-065, FR-080). The API only queues and reads. The worker
// is the one process that talks to a provider (FR-070), so nothing here imports it.

export const jobOperations: Operation<unknown>[] = [
  // Before /jobs/:id, so that "status" is not read as an id.
  defineOperation({
    method: 'get',
    path: '/jobs/status',
    operationId: 'getJobsStatus',
    summary: 'What the Jobs page needs besides the list: whether a worker is alive, which providers are configured, and whether a provider check is offered',
    description:
      'Reports each configured operation\'s provider, model and whether data sent to it leaves the install, never a key or an address. ' +
      'A worker is alive if one reported in the last 30 seconds and is not stopping. provider_check.next_allowed_at is when the signed-in ' +
      'account may start its next provider check, or null if it may now.',
    response: { name: 'JobsStatus', schema: JobsStatus },
    status: 200,
    errors: [],
    handler: async ({ accountId }) => {
      const ai = parseLlmStatus(process.env);
      const next = await nextAllowedAt(kdb, accountId, currentJobConfig());
      return {
        worker_alive: await workerAlive(kdb),
        ai: { generation: ai.generation, embedding: ai.embedding },
        provider_check: { offered: ai.generation !== null || ai.embedding !== null, next_allowed_at: next === null ? null : next.toISOString() },
      };
    },
  }),
  defineOperation({
    method: 'get',
    path: '/jobs',
    operationId: 'listJobs',
    summary: 'List jobs, newest first, a page at a time',
    description: 'Every job of every account, newest first by the time it was queued; ties broken by id, descending.',
    query: { name: 'JobListQuery', schema: JobListQuery },
    response: { name: 'JobList', schema: JobList },
    status: 200,
    errors: [400],
    handler: async ({ query }) => {
      const { jobs, hasMore } = await listJobs(kdb, query);
      return { jobs, has_more: hasMore };
    },
  }),
  defineOperation({
    method: 'post',
    path: '/jobs',
    operationId: 'createJob',
    summary: 'Queue a job',
    description:
      'Queues a job and answers at once, without waiting for the work. Its caps, runs and time limit are the operator\'s settings, copied onto it; ' +
      'a request cannot set them. A provider check takes no input. 409: no AI provider is configured. 429: the account already has too many jobs ' +
      'queued or running, or started a provider check too recently; Retry-After says how many seconds to wait.',
    body: { name: 'JobCreateInput', schema: JobCreateInput },
    response: { name: 'JobRecord', schema: JobRecord },
    status: 201,
    errors: [400, 409, 429],
    // No recordType: the router would log a write of a record type the write log does not have. The handler logs the start.
    handler: async ({ body, accountId }) => {
      if (CALLS_MODEL[body.kind]) {
        const ai = parseLlmStatus(process.env);
        if (ai.generation === null && ai.embedding === null) throw new HttpError(409, 'AI is not configured on this install');
      }
      let id: string;
      try {
        id = await enqueue(kdb, { kind: body.kind, input: body.input, accountId }, currentJobConfig());
      } catch (error) {
        // The limit on active jobs, or the cooldown: nothing was queued, and nothing is logged (FR-046, FR-047).
        if (error instanceof JobLimitError) throw new HttpError(429, error.message, { 'Retry-After': String(error.retryAfterSeconds) });
        throw error;
      }
      logJobAction(accountId, 'start', id, body.kind);
      return orNotFound(await getJob(kdb, id), 'Job');
    },
  }),
  defineOperation({
    method: 'get',
    path: '/jobs/:id',
    operationId: 'getJob',
    summary: 'Get one job with its usage records',
    description: 'For a provider check, the result shows each operation\'s provider, model, whether it is hosted, its outcome with a message and a hint, and its usage.',
    response: { name: 'JobDetail', schema: JobDetail },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => orNotFound(await getDetail(kdb, id), 'Job'),
  }),
  defineOperation({
    method: 'post',
    path: '/jobs/:id/cancel',
    operationId: 'cancelJob',
    summary: 'Cancel a job',
    description:
      'A queued job ends as cancelled at once and never starts. A running job whose worker is alive is marked, and its worker ends it within ' +
      'seconds, abandoning the request in progress; the answer shows cancel_requested until then. A running job whose worker is gone ends at once. ' +
      'Asking again changes nothing. 409: the job has already finished. There is no body.',
    response: { name: 'JobRecord', schema: JobRecord },
    status: 200,
    errors: [400, 404, 409],
    handler: async ({ id, accountId }) => {
      let cancelled;
      try {
        cancelled = await cancelJob(kdb, id, accountId);
      } catch (error) {
        if (error instanceof JobFinishedError) throw new HttpError(409, error.message);
        throw error;
      }
      const job = orNotFound(cancelled, 'Job');
      logJobAction(accountId, 'cancel', id);
      return job;
    },
  }),
];
