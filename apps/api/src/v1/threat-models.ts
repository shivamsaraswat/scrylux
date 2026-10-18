import {
  ElementRecord,
  MitigationRecord,
  ThreatModelCreateInput,
  ThreatModelRecord,
  ThreatModelUpdateInput,
  ThreatRecord,
} from '@scrylux/core';
import { kdb } from '../db.js';
import { orNotFound } from './errors.js';
import { LIST_ORDER_DESCRIPTION, defineOperation, type Operation } from './operation.js';

async function requireModel(id: string): Promise<void> {
  orNotFound(await kdb.selectFrom('threat_models').select('id').where('id', '=', id).executeTakeFirst(), 'Threat model');
}

export const threatModelOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'post',
    path: '/threat-models',
    operationId: 'createThreatModel',
    summary: 'Create a threat model in a project',
    body: { name: 'ThreatModelCreateInput', schema: ThreatModelCreateInput },
    response: { name: 'ThreatModelRecord', schema: ThreatModelRecord },
    status: 201,
    errors: [400, 409],
    recordType: 'threat_model',
    handler: ({ body }) => kdb.insertInto('threat_models').values(body).returningAll().executeTakeFirstOrThrow(),
  }),
  defineOperation({
    method: 'get',
    path: '/threat-models/:id',
    operationId: 'getThreatModel',
    summary: 'Get one threat model',
    response: { name: 'ThreatModelRecord', schema: ThreatModelRecord },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) =>
      orNotFound(
        await kdb.selectFrom('threat_models').selectAll().where('id', '=', id).executeTakeFirst(),
        'Threat model',
      ),
  }),
  defineOperation({
    method: 'patch',
    path: '/threat-models/:id',
    operationId: 'updateThreatModel',
    summary: 'Update the fields sent; the others stay as they are',
    description: 'Any status can be set at any time, in any direction.',
    body: { name: 'ThreatModelUpdateInput', schema: ThreatModelUpdateInput },
    response: { name: 'ThreatModelRecord', schema: ThreatModelRecord },
    status: 200,
    errors: [400, 404, 409],
    recordType: 'threat_model',
    handler: async ({ id, body }) =>
      orNotFound(
        await kdb.updateTable('threat_models').set(body).where('id', '=', id).returningAll().executeTakeFirst(),
        'Threat model',
      ),
  }),
  defineOperation({
    method: 'delete',
    path: '/threat-models/:id',
    operationId: 'deleteThreatModel',
    summary: 'Delete a threat model and everything inside it',
    status: 204,
    errors: [400, 404],
    recordType: 'threat_model',
    handler: async ({ id }) =>
      orNotFound(
        await kdb.deleteFrom('threat_models').where('id', '=', id).returning('id').executeTakeFirst(),
        'Threat model',
      ),
  }),
  defineOperation({
    method: 'get',
    path: '/threat-models/:id/elements',
    operationId: 'listThreatModelElements',
    summary: 'List the elements of one threat model',
    description: LIST_ORDER_DESCRIPTION,
    response: { name: 'ElementRecord', schema: ElementRecord, list: true },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      await requireModel(id);
      return kdb
        .selectFrom('elements')
        .selectAll()
        .where('threat_model_id', '=', id)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
    },
  }),
  defineOperation({
    method: 'get',
    path: '/threat-models/:id/threats',
    operationId: 'listThreatModelThreats',
    summary: 'List the threats of one threat model',
    description: LIST_ORDER_DESCRIPTION,
    response: { name: 'ThreatRecord', schema: ThreatRecord, list: true },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      await requireModel(id);
      return kdb
        .selectFrom('threats')
        .selectAll()
        .where('threat_model_id', '=', id)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
    },
  }),
  defineOperation({
    method: 'get',
    path: '/threat-models/:id/mitigations',
    operationId: 'listThreatModelMitigations',
    summary: 'List the mitigations of every threat in one threat model',
    description: LIST_ORDER_DESCRIPTION,
    response: { name: 'MitigationRecord', schema: MitigationRecord, list: true },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      await requireModel(id);
      return kdb
        .selectFrom('mitigations')
        .innerJoin('threats', 'threats.id', 'mitigations.threat_id')
        .where('threats.threat_model_id', '=', id)
        .selectAll('mitigations')
        .orderBy('mitigations.created_at')
        .orderBy('mitigations.id')
        .execute();
    },
  }),
];
