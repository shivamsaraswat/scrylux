import { AssetInput, AssetRecord, AssetUpdate } from '@scrylux/core';
import type { Database } from '@scrylux/db';
import { sql, type Kysely, type Transaction } from 'kysely';
import { kdb } from '../db.js';
import { lockModel } from './element-writes.js';
import { HttpError, orNotFound } from './errors.js';
import { LIST_ORDER_DESCRIPTION, defineOperation, type Operation } from './operation.js';

// Assets of a threat model (Phase 3 Milestone 5, contracts/http-api.md): a name, a description and the elements that hold it. An accept creates them from a
// draft, and a person can create, edit and delete them too (FR-006, FR-021). Every write takes the threat model's lock first, as every write to its elements
// does (research #4). A name is unique within a threat model, a holder is a process, a data store or an external entity of the same threat model, and a
// threat model holds at most 200: the database enforces all three, and `mapStorageError` answers them with fixed messages.

type Db = Kysely<Database>;

/** The holders of the given assets, by asset, in the order the elements were created. */
async function holdersOf(db: Db, assetIds: readonly string[]): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (assetIds.length === 0) return found;
  const rows = await db
    .selectFrom('asset_holders')
    .innerJoin('elements', 'elements.id', 'asset_holders.element_id')
    .select(['asset_holders.asset_id', 'asset_holders.element_id'])
    .where('asset_holders.asset_id', 'in', assetIds)
    .orderBy('elements.created_at')
    .orderBy('elements.id')
    .execute();
  for (const row of rows) found.set(row.asset_id, [...(found.get(row.asset_id) ?? []), row.element_id]);
  return found;
}

async function recordOf(db: Db, id: string) {
  const row = orNotFound(await db.selectFrom('assets').selectAll().where('id', '=', id).executeTakeFirst(), 'Asset');
  return { ...row, holder_ids: (await holdersOf(db, [id])).get(id) ?? [] };
}

async function setHolders(trx: Transaction<Database>, threatModelId: string, assetId: string, elementIds: readonly string[]): Promise<void> {
  await trx.deleteFrom('asset_holders').where('asset_id', '=', assetId).execute();
  if (elementIds.length > 0) {
    await trx.insertInto('asset_holders').values(elementIds.map((elementId) => ({ threat_model_id: threatModelId, asset_id: assetId, element_id: elementId }))).execute();
  }
}

async function modelOf(id: string): Promise<string> {
  return orNotFound(await kdb.selectFrom('assets').select('threat_model_id').where('id', '=', id).executeTakeFirst(), 'Asset').threat_model_id;
}

export const assetOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'get',
    path: '/threat-models/:id/assets',
    operationId: 'listAssets',
    summary: 'List the assets of one threat model, with the elements that hold each',
    description: LIST_ORDER_DESCRIPTION,
    response: { name: 'AssetRecord', schema: AssetRecord, list: true },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      orNotFound(await kdb.selectFrom('threat_models').select('id').where('id', '=', id).executeTakeFirst(), 'Threat model');
      const assets = await kdb.selectFrom('assets').selectAll().where('threat_model_id', '=', id).orderBy('created_at').orderBy('id').execute();
      const holders = await holdersOf(
        kdb,
        assets.map((asset) => asset.id),
      );
      return assets.map((asset) => ({ ...asset, holder_ids: holders.get(asset.id) ?? [] }));
    },
  }),
  defineOperation({
    method: 'post',
    path: '/threat-models/:id/assets',
    operationId: 'createAsset',
    summary: 'Create an asset in a threat model',
    description: 'A holder must be a process, a data store or an external entity of the same threat model. A name is unique within the threat model, ignoring case and surrounding whitespace.',
    body: { name: 'AssetInput', schema: AssetInput },
    response: { name: 'AssetRecord', schema: AssetRecord },
    status: 201,
    errors: [400, 404, 409],
    recordType: 'asset',
    handler: ({ id, body }) =>
      kdb.transaction().execute(async (trx) => {
        if (!(await lockModel(trx, id))) throw new HttpError(404, 'Threat model not found');
        const asset = await trx.insertInto('assets').values({ threat_model_id: id, name: body.name, description: body.description }).returningAll().executeTakeFirstOrThrow();
        await setHolders(trx, id, asset.id, body.holder_ids);
        return recordOf(trx, asset.id);
      }),
  }),
  defineOperation({
    method: 'patch',
    path: '/assets/:id',
    operationId: 'updateAsset',
    summary: 'Update the fields sent; the others stay as they are',
    description: '`holder_ids` replaces the set of holders.',
    body: { name: 'AssetUpdate', schema: AssetUpdate },
    response: { name: 'AssetRecord', schema: AssetRecord },
    status: 200,
    errors: [400, 404, 409],
    recordType: 'asset',
    handler: async ({ id, body }) => {
      const threatModelId = await modelOf(id);
      return kdb.transaction().execute(async (trx) => {
        await lockModel(trx, threatModelId);
        orNotFound(await trx.selectFrom('assets').select('id').where('id', '=', id).forUpdate().executeTakeFirst(), 'Asset');
        const { holder_ids: holders, ...fields } = body;
        // An update of the holders alone still refreshes the asset's `updated_at`: the row is touched, since an empty SET is not a statement.
        if (Object.keys(fields).length > 0) await trx.updateTable('assets').set(fields).where('id', '=', id).execute();
        else await sql`UPDATE assets SET name = name WHERE id = ${id}::uuid`.execute(trx);
        if (holders !== undefined) await setHolders(trx, threatModelId, id, holders);
        return recordOf(trx, id);
      });
    },
  }),
  defineOperation({
    method: 'delete',
    path: '/assets/:id',
    operationId: 'deleteAsset',
    summary: 'Delete an asset',
    status: 204,
    errors: [400, 404],
    recordType: 'asset',
    handler: async ({ id }) => {
      const threatModelId = await modelOf(id);
      await kdb.transaction().execute(async (trx) => {
        await lockModel(trx, threatModelId);
        await trx.deleteFrom('assets').where('id', '=', id).execute();
      });
    },
  }),
];
