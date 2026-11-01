import { ProjectCreateInput, ProjectRecord, ProjectUpdateInput, ThreatModelRecord } from '@scrylux/core';
import { kdb } from '../db.js';
import { currentSourcesContext } from '../sources/context.js';
import { deleteWithSources } from '../sources/store.js';
import { orNotFound } from './errors.js';
import { LIST_ORDER_DESCRIPTION, defineOperation, type Operation } from './operation.js';

export const projectOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'get',
    path: '/projects',
    operationId: 'listProjects',
    summary: 'List all projects',
    description: LIST_ORDER_DESCRIPTION,
    response: { name: 'ProjectRecord', schema: ProjectRecord, list: true },
    status: 200,
    errors: [],
    handler: () => kdb.selectFrom('projects').selectAll().orderBy('created_at').orderBy('id').execute(),
  }),
  defineOperation({
    method: 'post',
    path: '/projects',
    operationId: 'createProject',
    summary: 'Create a project, owned by the signed-in account',
    body: { name: 'ProjectCreateInput', schema: ProjectCreateInput },
    response: { name: 'ProjectRecord', schema: ProjectRecord },
    status: 201,
    errors: [400, 409],
    recordType: 'project',
    handler: ({ body, accountId }) =>
      kdb
        .insertInto('projects')
        .values({ ...body, created_by: accountId })
        .returningAll()
        .executeTakeFirstOrThrow(),
  }),
  defineOperation({
    method: 'get',
    path: '/projects/:id',
    operationId: 'getProject',
    summary: 'Get one project',
    response: { name: 'ProjectRecord', schema: ProjectRecord },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) =>
      orNotFound(await kdb.selectFrom('projects').selectAll().where('id', '=', id).executeTakeFirst(), 'Project'),
  }),
  defineOperation({
    method: 'patch',
    path: '/projects/:id',
    operationId: 'updateProject',
    summary: 'Update the fields sent; the others stay as they are',
    body: { name: 'ProjectUpdateInput', schema: ProjectUpdateInput },
    response: { name: 'ProjectRecord', schema: ProjectRecord },
    status: 200,
    errors: [400, 404, 409],
    recordType: 'project',
    handler: async ({ id, body }) =>
      orNotFound(
        await kdb.updateTable('projects').set(body).where('id', '=', id).returningAll().executeTakeFirst(),
        'Project',
      ),
  }),
  defineOperation({
    method: 'delete',
    path: '/projects/:id',
    operationId: 'deleteProject',
    summary: 'Delete a project and everything inside it',
    status: 204,
    errors: [400, 404],
    recordType: 'project',
    // The sources of its threat models go with it, and so do their originals (Phase 3 Milestone 3, FR-054).
    handler: async ({ id }) => orNotFound((await deleteWithSources(kdb, currentSourcesContext(), { kind: 'project', id })) ? { id } : undefined, 'Project'),
  }),
  defineOperation({
    method: 'get',
    path: '/projects/:id/threat-models',
    operationId: 'listProjectThreatModels',
    summary: 'List the threat models of one project',
    description: LIST_ORDER_DESCRIPTION,
    response: { name: 'ThreatModelRecord', schema: ThreatModelRecord, list: true },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      orNotFound(await kdb.selectFrom('projects').select('id').where('id', '=', id).executeTakeFirst(), 'Project');
      return kdb
        .selectFrom('threat_models')
        .selectAll()
        .where('project_id', '=', id)
        .orderBy('created_at')
        .orderBy('id')
        .execute();
    },
  }),
];
