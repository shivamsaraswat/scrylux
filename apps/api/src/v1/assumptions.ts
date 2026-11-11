import { AssumptionInput, AssumptionRecord, AssumptionUpdate } from '@scrylux/core';
import { kdb } from '../db.js';
import { lockModel } from './element-writes.js';
import { HttpError, orNotFound } from './errors.js';
import { LIST_ORDER_DESCRIPTION, defineOperation, type Operation } from './operation.js';

// Assumptions of a threat model (Phase 3 Milestone 5, contracts/http-api.md): a statement the design relies on. An accept creates them from a draft, and a person
// can create, edit and delete them too (FR-006, FR-021). A statement is unique within a threat model, ignoring case and surrounding whitespace, and a threat model
// holds at most 200: the database enforces both. Every write takes the threat model's lock first (research #4).

async function modelOf(id: string): Promise<string> {
  return orNotFound(await kdb.selectFrom('assumptions').select('threat_model_id').where('id', '=', id).executeTakeFirst(), 'Assumption').threat_model_id;
}

export const assumptionOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'get',
    path: '/threat-models/:id/assumptions',
    operationId: 'listAssumptions',
    summary: 'List the assumptions of one threat model',
    description: LIST_ORDER_DESCRIPTION,
    response: { name: 'AssumptionRecord', schema: AssumptionRecord, list: true },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      orNotFound(await kdb.selectFrom('threat_models').select('id').where('id', '=', id).executeTakeFirst(), 'Threat model');
      return kdb.selectFrom('assumptions').selectAll().where('threat_model_id', '=', id).orderBy('created_at').orderBy('id').execute();
    },
  }),
  defineOperation({
    method: 'post',
    path: '/threat-models/:id/assumptions',
    operationId: 'createAssumption',
    summary: 'Create an assumption in a threat model',
    description: 'A statement is unique within the threat model, ignoring case and surrounding whitespace.',
    body: { name: 'AssumptionInput', schema: AssumptionInput },
    response: { name: 'AssumptionRecord', schema: AssumptionRecord },
    status: 201,
    errors: [400, 404, 409],
    recordType: 'assumption',
    handler: ({ id, body }) =>
      kdb.transaction().execute(async (trx) => {
        if (!(await lockModel(trx, id))) throw new HttpError(404, 'Threat model not found');
        return trx.insertInto('assumptions').values({ threat_model_id: id, statement: body.statement }).returningAll().executeTakeFirstOrThrow();
      }),
  }),
  defineOperation({
    method: 'patch',
    path: '/assumptions/:id',
    operationId: 'updateAssumption',
    summary: 'Change the statement of an assumption',
    body: { name: 'AssumptionUpdate', schema: AssumptionUpdate },
    response: { name: 'AssumptionRecord', schema: AssumptionRecord },
    status: 200,
    errors: [400, 404, 409],
    recordType: 'assumption',
    handler: async ({ id, body }) => {
      const threatModelId = await modelOf(id);
      return kdb.transaction().execute(async (trx) => {
        await lockModel(trx, threatModelId);
        return orNotFound(await trx.updateTable('assumptions').set(body).where('id', '=', id).returningAll().executeTakeFirst(), 'Assumption');
      });
    },
  }),
  defineOperation({
    method: 'delete',
    path: '/assumptions/:id',
    operationId: 'deleteAssumption',
    summary: 'Delete an assumption',
    status: 204,
    errors: [400, 404],
    recordType: 'assumption',
    handler: async ({ id }) => {
      const threatModelId = await modelOf(id);
      await kdb.transaction().execute(async (trx) => {
        await lockModel(trx, threatModelId);
        await trx.deleteFrom('assumptions').where('id', '=', id).execute();
      });
    },
  }),
];
