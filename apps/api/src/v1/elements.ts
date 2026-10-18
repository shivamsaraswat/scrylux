import {
  ElementBatchInput,
  ElementBatchResult,
  ElementCreateInput,
  ElementRecord,
  ElementUpdateInput,
  MAX_BATCH_OPERATIONS,
} from '@scrylux/core';
import { kdb } from '../db.js';
import { createElementIn, deleteElementIn, lockModel, updateElementIn } from './element-writes.js';
import { HttpError, mapStorageError, orNotFound, prefixOperation } from './errors.js';
import { defineOperation, type Operation } from './operation.js';
import { logWrite, type WriteAction } from './write-log.js';

// The threat model an element belongs to, read before the model lock is taken: the lock comes first
// in every element write (research #6), and it is the model's.
async function modelOf(id: string): Promise<string> {
  const row = await kdb.selectFrom('elements').select('threat_model_id').where('id', '=', id).executeTakeFirst();
  return orNotFound(row, 'Element').threat_model_id;
}

export const elementOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'post',
    path: '/elements',
    operationId: 'createElement',
    summary: 'Create a diagram element in a threat model',
    body: { name: 'ElementCreateInput', schema: ElementCreateInput },
    response: { name: 'ElementRecord', schema: ElementRecord },
    status: 201,
    errors: [400],
    recordType: 'element',
    handler: ({ body }) =>
      kdb.transaction().execute(async (trx) => {
        // A model that does not exist is left to the foreign key, which answers 400 as it always has.
        await lockModel(trx, body.threat_model_id);
        return createElementIn(trx, body.threat_model_id, body);
      }),
  }),
  defineOperation({
    method: 'get',
    path: '/elements/:id',
    operationId: 'getElement',
    summary: 'Get one element',
    response: { name: 'ElementRecord', schema: ElementRecord },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) =>
      orNotFound(await kdb.selectFrom('elements').selectAll().where('id', '=', id).executeTakeFirst(), 'Element'),
  }),
  defineOperation({
    method: 'patch',
    path: '/elements/:id',
    operationId: 'updateElement',
    summary: 'Update the fields sent; the others stay as they are',
    body: { name: 'ElementUpdateInput', schema: ElementUpdateInput },
    response: { name: 'ElementRecord', schema: ElementRecord },
    status: 200,
    errors: [400, 404],
    recordType: 'element',
    handler: async ({ id, body }) => {
      const modelId = await modelOf(id);
      return kdb.transaction().execute(async (trx) => {
        await lockModel(trx, modelId);
        return updateElementIn(trx, modelId, id, body);
      });
    },
  }),
  defineOperation({
    method: 'delete',
    path: '/elements/:id',
    operationId: 'deleteElement',
    summary: 'Delete an element, along with the data flows that use it',
    description: 'Rejected while the element, or a data flow deleted with it, still has threats.',
    status: 204,
    errors: [400, 404, 409],
    recordType: 'element',
    handler: async ({ id, accountId }) => {
      const modelId = await modelOf(id);
      const { updated } = await kdb.transaction().execute(async (trx) => {
        await lockModel(trx, modelId);
        return deleteElementIn(trx, modelId, id);
      });
      // Members a boundary delete moved are updates too (FR-030). The router logs the delete itself.
      for (const member of updated) logWrite(accountId, 'update', 'element', member.id);
    },
  }),
  defineOperation({
    method: 'post',
    path: '/threat-models/:id/elements/batch',
    operationId: 'batchElements',
    summary: 'Create, update and delete several elements of one threat model, all or none',
    description:
      `Applies up to ${MAX_BATCH_OPERATIONS} operations, in order, in one transaction: all or none are stored. ` +
      'Every element must belong to the threat model in the path. A create may choose its own id. ' +
      'The result lists each created or updated element once, in its final state, and the ids deleted. ' +
      'An error caused by one operation names its position, counted from 0. ' +
      'Positions (layout) are relative to the parent boundary.',
    body: { name: 'ElementBatchInput', schema: ElementBatchInput },
    response: { name: 'ElementBatchResult', schema: ElementBatchResult },
    status: 200,
    errors: [400, 404, 409],
    // No recordType: the router would log one line for the threat model. The handler logs each element.
    handler: async ({ id: threatModelId, body, accountId }) => {
      const logged: { action: WriteAction; id: string }[] = [];
      const touched = new Set<string>();
      const deleted = new Set<string>();

      await kdb.transaction().execute(async (trx) => {
        if (!(await lockModel(trx, threatModelId))) throw new HttpError(404, 'Threat model not found');
        for (const [index, operation] of body.operations.entries()) {
          try {
            if (operation.op === 'create') {
              const row = await createElementIn(trx, threatModelId, operation.element);
              touched.add(row.id);
              logged.push({ action: 'create', id: row.id });
            } else if (operation.op === 'update') {
              const row = await updateElementIn(trx, threatModelId, operation.id, operation.changes);
              touched.add(row.id);
              logged.push({ action: 'update', id: row.id });
            } else {
              const { updated } = await deleteElementIn(trx, threatModelId, operation.id);
              deleted.add(operation.id);
              logged.push({ action: 'delete', id: operation.id });
              for (const member of updated) {
                touched.add(member.id);
                logged.push({ action: 'update', id: member.id });
              }
            }
          } catch (err) {
            const mapped = err instanceof HttpError ? err : mapStorageError(err, operation.op === 'delete' ? 'delete' : 'write');
            if (mapped === null) throw err;
            throw prefixOperation(index, mapped);
          }
        }
      });

      // The transaction has committed, so what is logged is stored.
      for (const { action, id } of logged) logWrite(accountId, action, 'element', id);

      const alive = [...touched].filter((elementId) => !deleted.has(elementId));
      const elements =
        alive.length === 0
          ? []
          : await kdb.selectFrom('elements').selectAll().where('id', 'in', alive).orderBy('created_at').orderBy('id').execute();
      return { elements, deleted: [...deleted] };
    },
  }),
];
