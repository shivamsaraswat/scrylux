import { MitigationRecord, ThreatCreateFields, ThreatRecord, ThreatUpdateInput, needsReason, threatLifecycleIssues } from '@scrylux/core';
import { z } from 'zod';
import { kdb } from '../db.js';
import { HttpError, orNotFound } from './errors.js';
import { LIST_ORDER_DESCRIPTION, defineOperation, type Operation } from './operation.js';

// Through the API a threat is always manual. Core's schema also allows "rule" and "ai" for the rule
// engine (Phase 2) and AI drafts (Phase 3), which write on the server's behalf: letting a client claim
// either would fake provenance (FR-009, Principles V and VI). As in core, origin has no default.
const ThreatCreateInputV1 = ThreatCreateFields.extend({ origin: z.literal('manual') }).superRefine(threatLifecycleIssues('create'));

const MITIGATED_REFUSED = 'A threat can be set to mitigated only when at least one of its mitigations is implemented or verified';

export const threatOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'post',
    path: '/threats',
    operationId: 'createThreat',
    summary: 'Create a threat for a threat model, or for one of its elements',
    description:
      'origin is required and must be "manual". Risk is derived from likelihood and impact. A threat can\'t be created as mitigated. status_reason is required when status is accepted or not_applicable, and must be left out otherwise.',
    body: { name: 'ThreatCreateInput', schema: ThreatCreateInputV1 },
    response: { name: 'ThreatRecord', schema: ThreatRecord },
    status: 201,
    errors: [400],
    recordType: 'threat',
    handler: ({ body }) => kdb.insertInto('threats').values(body).returningAll().executeTakeFirstOrThrow(),
  }),
  defineOperation({
    method: 'get',
    path: '/threats/:id',
    operationId: 'getThreat',
    summary: 'Get one threat',
    response: { name: 'ThreatRecord', schema: ThreatRecord },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) =>
      orNotFound(await kdb.selectFrom('threats').selectAll().where('id', '=', id).executeTakeFirst(), 'Threat'),
  }),
  defineOperation({
    method: 'patch',
    path: '/threats/:id',
    operationId: 'updateThreat',
    summary: 'Update the fields sent; the others stay as they are',
    description:
      'origin cannot be changed; library_ref and element_id cannot change on a threat whose origin is rule. A threat can be moved to mitigated only when at least one of its mitigations is implemented or verified (409 otherwise). status_reason is required whenever status is set to accepted or not_applicable, must be left out when status is set to open or mitigated (which clears it), and can be sent alone only to a threat that is accepted or not_applicable.',
    body: { name: 'ThreatUpdateInput', schema: ThreatUpdateInput },
    response: { name: 'ThreatRecord', schema: ThreatRecord },
    status: 200,
    errors: [400, 404, 409],
    recordType: 'threat',
    // One transaction (research #3). The threat row is locked first, so two status changes on one threat queue.
    // Moving into mitigated then needs an implemented or verified mitigation, read FOR SHARE: a mitigation
    // being downgraded or deleted at the same moment holds its row lock, so this waits for it and then sees the
    // result, and one that changes afterwards waits for this transaction. A threat that is already mitigated is
    // not being moved, so it is not checked (spec FR-006).
    handler: ({ id, body }) =>
      kdb.transaction().execute(async (trx) => {
        const stored = orNotFound(
          await trx.selectFrom('threats').select('status').where('id', '=', id).forNoKeyUpdate().executeTakeFirst(),
          'Threat',
        );
        if (body.status === 'mitigated' && stored.status !== 'mitigated') {
          const implemented = await trx
            .selectFrom('mitigations')
            .select('id')
            .where('threat_id', '=', id)
            .where('status', 'in', ['implemented', 'verified'])
            .limit(1)
            .forShare()
            .executeTakeFirst();
          if (implemented === undefined) throw new HttpError(409, MITIGATED_REFUSED);
        }
        // Moving to a status that takes no reason clears the one the old status had (spec FR-005).
        const clearsReason = body.status !== undefined && !needsReason(body.status);
        return trx
          .updateTable('threats')
          .set(clearsReason ? { ...body, status_reason: null } : body)
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();
      }),
  }),
  defineOperation({
    method: 'delete',
    path: '/threats/:id',
    operationId: 'deleteThreat',
    summary: 'Delete a threat and its mitigations',
    status: 204,
    errors: [400, 404],
    recordType: 'threat',
    handler: async ({ id }) =>
      orNotFound(await kdb.deleteFrom('threats').where('id', '=', id).returning('id').executeTakeFirst(), 'Threat'),
  }),
  defineOperation({
    method: 'get',
    path: '/threats/:id/mitigations',
    operationId: 'listThreatMitigations',
    summary: 'List the mitigations of one threat',
    description: LIST_ORDER_DESCRIPTION,
    response: { name: 'MitigationRecord', schema: MitigationRecord, list: true },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      orNotFound(await kdb.selectFrom('threats').select('id').where('id', '=', id).executeTakeFirst(), 'Threat');
      return kdb
        .selectFrom('mitigations')
        .selectAll()
        .where('threat_id', '=', id)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
    },
  }),
];
