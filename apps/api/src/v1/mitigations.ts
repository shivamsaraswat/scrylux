import { MitigationCreateInput, MitigationRecord, MitigationUpdateInput } from '@scrylux/core';
import { kdb } from '../db.js';
import { orNotFound } from './errors.js';
import { defineOperation, type Operation } from './operation.js';

export const mitigationOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'post',
    path: '/mitigations',
    operationId: 'createMitigation',
    summary: 'Create a mitigation for a threat',
    body: { name: 'MitigationCreateInput', schema: MitigationCreateInput },
    response: { name: 'MitigationRecord', schema: MitigationRecord },
    status: 201,
    errors: [400],
    recordType: 'mitigation',
    handler: ({ body }) => kdb.insertInto('mitigations').values(body).returningAll().executeTakeFirstOrThrow(),
  }),
  defineOperation({
    method: 'get',
    path: '/mitigations/:id',
    operationId: 'getMitigation',
    summary: 'Get one mitigation',
    response: { name: 'MitigationRecord', schema: MitigationRecord },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) =>
      orNotFound(
        await kdb.selectFrom('mitigations').selectAll().where('id', '=', id).executeTakeFirst(),
        'Mitigation',
      ),
  }),
  defineOperation({
    method: 'patch',
    path: '/mitigations/:id',
    operationId: 'updateMitigation',
    summary: 'Update the fields sent; the others stay as they are',
    description: 'Any status can be set at any time, in any direction.',
    body: { name: 'MitigationUpdateInput', schema: MitigationUpdateInput },
    response: { name: 'MitigationRecord', schema: MitigationRecord },
    status: 200,
    errors: [400, 404],
    recordType: 'mitigation',
    handler: async ({ id, body }) =>
      orNotFound(
        await kdb.updateTable('mitigations').set(body).where('id', '=', id).returningAll().executeTakeFirst(),
        'Mitigation',
      ),
  }),
  defineOperation({
    method: 'delete',
    path: '/mitigations/:id',
    operationId: 'deleteMitigation',
    summary: 'Delete a mitigation',
    status: 204,
    errors: [400, 404],
    recordType: 'mitigation',
    handler: async ({ id }) =>
      orNotFound(
        await kdb.deleteFrom('mitigations').where('id', '=', id).returning('id').executeTakeFirst(),
        'Mitigation',
      ),
  }),
];
