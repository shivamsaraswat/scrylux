import { ElementShape, formatValidationError, type ElementBatchOperation, type ElementUpdateInput } from '@scrylux/core';
import type { Transaction } from 'kysely';
import type { Database } from '@scrylux/db';
import { HttpError } from './errors.js';

// Element writes that run inside a transaction the caller owns. The single-record endpoints and the
// batch endpoint share them, so a rule is written once (contracts/elements-batch.md). Every write
// transaction on a threat model's elements takes the model lock first (lockModel), then row locks,
// so writers to one model queue behind each other and can never deadlock (research #6).

type Trx = Transaction<Database>;
type CreateElement = Extract<ElementBatchOperation, { op: 'create' }>['element'];

// The per-threat-model lock that 006's boundary check and 013's limit check take. FOR NO KEY UPDATE
// does not conflict with the KEY SHARE locks of ordinary foreign-key checks. Returns false when the
// threat model does not exist.
export async function lockModel(trx: Trx, threatModelId: string): Promise<boolean> {
  const row = await trx.selectFrom('threat_models').select('id').where('id', '=', threatModelId).forNoKeyUpdate().executeTakeFirst();
  return row !== undefined;
}

// The element's row, locked, if it exists in this threat model. An element of another model is the
// same as no element: a write can never reach across threat models.
async function lockElement(trx: Trx, threatModelId: string, id: string) {
  const row = await trx
    .selectFrom('elements')
    .selectAll()
    .where('id', '=', id)
    .where('threat_model_id', '=', threatModelId)
    .forUpdate()
    .executeTakeFirst();
  if (row === undefined) throw new HttpError(404, 'Element not found');
  return row;
}

export async function createElementIn(trx: Trx, threatModelId: string, element: CreateElement | (Omit<CreateElement, 'id'> & { id?: undefined })) {
  const { id, ...fields } = element;
  return trx
    .insertInto('elements')
    .values({ ...fields, ...(id === undefined ? {} : { id }), threat_model_id: threatModelId })
    .returningAll()
    .executeTakeFirstOrThrow();
}

// The patch is applied to the locked row, and the fields it writes are checked against the merged
// result: `properties` when it is sent or when the type changes, `layout` when it is sent. A field the
// patch leaves alone is not checked, so an element stored before the vocabulary existed can still be
// renamed (research #3).
export async function updateElementIn(trx: Trx, threatModelId: string, id: string, changes: ElementUpdateInput) {
  const row = await lockElement(trx, threatModelId, id);
  const type = changes.type ?? row.type;
  const checked = {
    type,
    ...(changes.properties !== undefined || type !== row.type ? { properties: changes.properties ?? row.properties } : {}),
    ...(changes.layout !== undefined ? { layout: changes.layout } : {}),
  };
  const result = ElementShape.safeParse(checked);
  if (!result.success) throw new HttpError(400, formatValidationError(result.error));
  // What is stored is the checked value, which has its tags trimmed.
  const set = {
    ...changes,
    ...(changes.properties === undefined ? {} : { properties: result.data.properties }),
    ...(changes.layout === undefined ? {} : { layout: result.data.layout }),
  };
  return trx.updateTable('elements').set(set).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
}

export interface DeleteResult {
  // Elements changed as a side effect of the delete, to be logged and returned to the caller.
  updated: { id: string }[];
}

// Deleting a trust boundary keeps what it holds (spec FR-022): its direct members, nodes and boundaries alike,
// move up to the boundary's own parent, or to the top level if it had none. Positions are stored relative to the
// parent, so each member's position is converted into the new frame and it stays where it is on the diagram. A
// member with no layout stays without one. Returns the members it moved, for the response and the log.
export async function deleteElementIn(trx: Trx, threatModelId: string, id: string): Promise<DeleteResult> {
  const row = await lockElement(trx, threatModelId, id);
  const updated: { id: string }[] = [];
  if (row.type === 'trust_boundary') {
    const members = await trx.selectFrom('elements').selectAll().where('parent_boundary_id', '=', id).orderBy('created_at').orderBy('id').forUpdate().execute();
    const offset = pointOf(row.layout);
    for (const member of members) {
      const here = pointOf(member.layout);
      const layout = here && offset ? { ...member.layout, x: here.x + offset.x, y: here.y + offset.y } : member.layout;
      updated.push(
        await trx
          .updateTable('elements')
          .set({ parent_boundary_id: row.parent_boundary_id, layout })
          .where('id', '=', member.id)
          .returningAll()
          .executeTakeFirstOrThrow(),
      );
    }
  }
  await trx.deleteFrom('elements').where('id', '=', id).execute();
  return { updated };
}

function pointOf(layout: unknown): { x: number; y: number } | null {
  if (typeof layout !== 'object' || layout === null) return null;
  const { x, y } = layout as Record<string, unknown>;
  return typeof x === 'number' && typeof y === 'number' ? { x, y } : null;
}
