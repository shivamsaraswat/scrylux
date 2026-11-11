import { randomUUID } from 'node:crypto';
import { ElementShape, MAX_ASSETS, MAX_ASSUMPTIONS, MAX_ELEMENTS, formatValidationError, type DraftDecision, type DraftElementRecord, type EditRef, type ItemEdits, type JsonValue } from '@scrylux/core';
import type { Database } from '@scrylux/db';
import { sql, type Transaction } from 'kysely';
import { kdb } from '../db.js';
import { readDraft, type StoredDraft } from '../extract-system/draft.js';
import { createElementIn, lockModel, updateElementIn } from '../v1/element-writes.js';
import { HttpError } from '../v1/errors.js';
import { loadReview } from './compare.js';
import { writeProvenance, type ProvenanceMark } from './provenance.js';

// Deciding the items of a draft (Phase 3 Milestone 5, research #4, #5): one transaction, under the threat model's lock and then the draft's, so a
// second request waits and then finds what the first did, and a draft that was replaced or discarded is refused before anything is written. Every
// record is built from the draft this module reads: a request names items, and nothing else reaches a record (FR-007).

type Accept = Extract<DraftDecision, { action: 'accept' }>;
type Mark = Extract<DraftDecision, { action: 'reject' | 'undecide' }>;

export interface AcceptResult {
  created: number;
  changed: number;
  unlinked_holders: Array<{ asset_item_id: string; element_item_id: string }>;
}

const NODE_TYPES: ReadonlySet<string> = new Set(['process', 'data_store', 'external_entity']);

/** The room a threat model has for one more kind of record: refused as a whole, with how many more fit (FR-012). */
function requireRoom(existing: number, adding: number, max: number, what: string): void {
  if (existing + adding > max) throw new HttpError(409, `A threat model can hold ${max.toLocaleString('en-US')} ${what}; ${Math.max(0, max - existing)} more fit`);
}

type DecisionTrx = Transaction<Database>;

/**
 * The start of every decision, in the lock order of research #4: the threat model, then the draft the reviewer saw (it must still be the draft, FR-011), then the
 * items named, in position order. Returns the draft as stored and the review of its items.
 */
async function openDecision(trx: DecisionTrx, threatModelId: string, draftId: string, ids: readonly string[]) {
  if (!(await lockModel(trx, threatModelId))) throw new HttpError(404, 'Threat model not found');
  const current = await sql<{ id: string }>`SELECT id FROM drafts WHERE threat_model_id = ${threatModelId}::uuid FOR UPDATE`.execute(trx);
  if (current.rows[0]?.id !== draftId) throw new HttpError(409, 'This draft was replaced or discarded');
  const found = await sql<{ id: string }>`SELECT id FROM draft_items WHERE draft_id = ${draftId}::uuid AND id = ANY(${ids}::uuid[]) ORDER BY "position" FOR UPDATE`.execute(trx);
  if (found.rows.length !== ids.length) throw new HttpError(404, 'Draft item not found');
  const draft = (await readDraft(trx, threatModelId)) as StoredDraft;
  return { draft, ...(await loadReview(trx, draft)) };
}

/** Rejecting items, or returning rejected ones to undecided: only the decision columns change, and nothing in the threat model (FR-014, FR-015). */
async function mark(threatModelId: string, accountId: number, body: Mark): Promise<AcceptResult> {
  return kdb.transaction().execute(async (trx) => {
    const ids = body.items.map((item) => item.id);
    const { review } = await openDecision(trx, threatModelId, body.draft_id, ids);
    const wrong = ids.filter((id) => review[id]?.state !== (body.action === 'reject' ? 'undecided' : 'rejected')).length;
    if (wrong > 0) throw new HttpError(409, `${wrong} of the items were already decided`);
    if (body.action === 'reject') {
      await sql`UPDATE draft_items SET decision = 'rejected', decided_by = ${accountId}, decided_at = now(), outcome = NULL, element_id = NULL, asset_id = NULL, assumption_id = NULL WHERE id = ANY(${ids}::uuid[])`.execute(trx);
    } else {
      await sql`UPDATE draft_items SET decision = NULL, decided_by = NULL, decided_at = NULL, outcome = NULL, element_id = NULL, asset_id = NULL, assumption_id = NULL WHERE id = ANY(${ids}::uuid[])`.execute(trx);
    }
    return { created: 0, changed: 0, unlinked_holders: [] };
  });
}

export const reject = (threatModelId: string, accountId: number, body: Extract<Mark, { action: 'reject' }>): Promise<AcceptResult> => mark(threatModelId, accountId, body);
export const undecide = (threatModelId: string, accountId: number, body: Extract<Mark, { action: 'undecide' }>): Promise<AcceptResult> => mark(threatModelId, accountId, body);

export async function accept(threatModelId: string, accountId: number, body: Accept): Promise<AcceptResult> {
  return kdb.transaction().execute(async (trx) => {
    const ids = body.items.map((item) => item.id);
    const { draft, review, resolve } = await openDecision(trx, threatModelId, body.draft_id, ids);

    const decided = body.items.filter((item) => review[item.id]?.state === 'accepted').length;
    if (decided > 0) throw new HttpError(409, `${decided} of the items were already decided`);
    const stale = body.items.filter((item) => review[item.id]?.comparison !== item.seen).length;
    if (stale > 0) throw new HttpError(409, `${stale} of the items are out of date; the threat model changed`);

    // What a person changed while accepting (FR-013): only fields the kind of item takes, never on an item that is already in the model, and references only to
    // elements of the draft (a reference to an element of the threat model is checked by the database's own keys and rules).
    const editsOf = new Map<string, ItemEdits>(body.items.flatMap((item) => (item.edits === undefined ? [] : [[item.id, item.edits] as [string, ItemEdits]])));
    for (const [id, edits] of editsOf) {
      const element = draft.elements.find((candidate) => candidate.id === id);
      const takes = element !== undefined ? (element.type === 'data_flow' ? ['name', 'flags', 'source', 'target'] : ['name', 'flags', 'boundary']) : draft.assets.some((asset) => asset.id === id) ? ['name', 'description', 'holders'] : ['statement'];
      const given = Object.entries(edits).filter(([, value]) => value !== undefined);
      if (given.some(([field]) => !takes.includes(field))) throw new HttpError(400, 'This edit does not apply to this kind of item');
      if (given.length > 0 && review[id]?.comparison === 'matched') throw new HttpError(400, 'An item that is already in the model cannot be edited');
      const references: EditRef[] = [edits.boundary, edits.source, edits.target, ...(edits.holders ?? [])].filter((ref): ref is EditRef => ref !== undefined && ref !== null);
      if (references.some((ref) => 'item' in ref && !draft.elements.some((candidate) => candidate.id === ref.item))) {
        throw new HttpError(400, 'An edit refers to an item that is not an element of the draft');
      }
    }

    // What each requested item becomes: a record of its own, or the one record it matched (FR-008).
    const requested = new Set(ids);
    const matched = (id: string): boolean => review[id]?.comparison === 'matched';
    const elementOf = new Map<string, DraftElementRecord>(draft.elements.map((element) => [element.id, element]));
    const assetOf = new Map(draft.assets.map((asset) => [asset.id, asset]));
    const assumptionOf = new Map(draft.assumptions.map((assumption) => [assumption.id, assumption]));
    const newId = new Map<string, string>();
    for (const id of ids) if (!matched(id)) newId.set(id, randomUUID());

    // The element an item stands for once this request is done: the one it will create, the one it matches, or what it resolves to now (research #5).
    const refOf = (itemId: string | null): string | null => {
      if (itemId === null) return null;
      if (!requested.has(itemId)) return resolve(itemId);
      return matched(itemId) ? (review[itemId]?.matched_id ?? null) : (newId.get(itemId) ?? null);
    };

    const refFrom = (ref: EditRef): string | null => ('element' in ref ? ref.element : refOf(ref.item));
    const creating = ids.flatMap((id) => (elementOf.has(id) && !matched(id) ? [elementOf.get(id) as DraftElementRecord] : []));
    // The elements a new element refers to: what the draft says, or what the edit says instead. One that is meant and is nowhere in the model or the request is a need.
    const refsOf = (element: DraftElementRecord): { source: string | null; target: string | null; parent: string | null; missing: boolean } => {
      const edits = editsOf.get(element.id);
      const flow = element.type === 'data_flow';
      const pick = (edited: EditRef | null | undefined, drafted: string | null): { value: string | null; meant: boolean } => {
        if (edited === undefined) return { value: refOf(drafted), meant: drafted !== null };
        return edited === null ? { value: null, meant: false } : { value: refFrom(edited), meant: true };
      };
      const source = flow ? pick(edits?.source, element.source_id) : { value: null, meant: false };
      const target = flow ? pick(edits?.target, element.target_id) : { value: null, meant: false };
      const parent = flow ? { value: null, meant: false } : pick(edits?.boundary, element.boundary_id);
      return { source: source.value, target: target.value, parent: parent.value, missing: [source, target, parent].some((reference) => reference.meant && reference.value === null) };
    };
    const needy = creating.filter((element) => refsOf(element).missing).length;
    if (needy > 0) throw new HttpError(409, `${needy} items need elements that are not in the threat model`);

    const creatingAssets = ids.filter((id) => assetOf.has(id) && !matched(id)).length;
    const creatingAssumptions = ids.filter((id) => assumptionOf.has(id) && !matched(id)).length;
    const existing = async (table: 'elements' | 'assets' | 'assumptions'): Promise<number> => {
      const { rows } = await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.table(table)} WHERE threat_model_id = ${threatModelId}::uuid`.execute(trx);
      return rows[0]?.n ?? 0;
    };
    if (creating.length > 0) requireRoom(await existing('elements'), creating.length, MAX_ELEMENTS, 'elements');
    if (creatingAssets > 0) requireRoom(await existing('assets'), creatingAssets, MAX_ASSETS, 'assets');
    if (creatingAssumptions > 0) requireRoom(await existing('assumptions'), creatingAssumptions, MAX_ASSUMPTIONS, 'assumptions');

    const marks: ProvenanceMark[] = [];
    let created = 0;
    let changed = 0;

    // Boundaries first, a boundary before the boundaries inside it, then nodes, then flows: the element trigger reads a row's parent and the ends of a flow.
    const boundaries = creating.filter((element) => element.type === 'trust_boundary');
    const ordered: DraftElementRecord[] = [];
    for (let pending = boundaries; pending.length > 0; ) {
      const ready = pending.filter((boundary) => boundary.boundary_id === null || !newId.has(boundary.boundary_id) || ordered.some((done) => done.id === boundary.boundary_id));
      if (ready.length === 0) throw new Error('trust boundaries of a draft nest in a cycle');
      ordered.push(...ready);
      pending = pending.filter((boundary) => !ready.includes(boundary));
    }
    ordered.push(...creating.filter((element) => element.type !== 'trust_boundary' && element.type !== 'data_flow'), ...creating.filter((element) => element.type === 'data_flow'));
    for (const element of ordered) {
      const edits = editsOf.get(element.id);
      // The flags it will have: the draft's, then what the person set or cleared. The rules of the type are the element schema's, as for any write.
      const flags = new Map<string, boolean>(element.flags.map((flag) => [flag.flag, flag.value]));
      for (const [flag, value] of Object.entries(edits?.flags ?? {})) {
        if (value === null) flags.delete(flag);
        else flags.set(flag, value);
      }
      const properties: Record<string, JsonValue> = flags.size === 0 ? {} : { flags: Object.fromEntries(flags) };
      const shape = ElementShape.safeParse({ type: element.type, properties });
      if (!shape.success) throw new HttpError(400, formatValidationError(shape.error));
      const refs = refsOf(element);
      const elementId = newId.get(element.id) as string;
      await createElementIn(trx, threatModelId, {
        id: elementId,
        type: element.type,
        name: edits?.name ?? element.name,
        properties,
        layout: null,
        source_element_id: refs.source,
        target_element_id: refs.target,
        parent_boundary_id: refs.parent,
      });
      created += 1;
      marks.push({ elementId, flag: null, rationale: element.rationale, itemId: element.id });
      // A flag the person changed, cleared or added is theirs and carries no mark; one that stayed as proposed keeps its citations.
      for (const flag of element.flags) if (flags.get(flag.flag) === flag.value) marks.push({ elementId, flag: flag.flag, rationale: element.rationale, itemId: element.id });
    }

    // An element that was already there gets only the flags it has not assessed, and nothing else changes (FR-008).
    for (const id of ids) {
      const element = elementOf.get(id);
      const matchedId = review[id]?.matched_id;
      if (element === undefined || !matched(id) || matchedId === null || matchedId === undefined) continue;
      const row = await trx.selectFrom('elements').select(['properties']).where('id', '=', matchedId).executeTakeFirstOrThrow();
      const stored = ((row.properties as { flags?: Record<string, boolean> }).flags ?? {});
      const added = element.flags.filter((flag) => stored[flag.flag] === undefined);
      if (added.length === 0) continue;
      await updateElementIn(trx, threatModelId, matchedId, { properties: { ...(row.properties as Record<string, JsonValue>), flags: { ...stored, ...Object.fromEntries(added.map((flag) => [flag.flag, flag.value])) } } });
      changed += 1;
      for (const flag of added) marks.push({ elementId: matchedId, flag: flag.flag, rationale: element.rationale, itemId: id });
    }

    // Assets and assumptions. A holder is linked when it is a node that is in the model or in the request, and listed otherwise (FR-009).
    const unlinked: AcceptResult['unlinked_holders'] = [];
    for (const id of ids) {
      const asset = assetOf.get(id);
      if (asset !== undefined) {
        let assetId = newId.get(id);
        if (assetId === undefined) assetId = review[id]?.matched_id as string;
        else {
          await trx.insertInto('assets').values({ id: assetId, threat_model_id: threatModelId, name: editsOf.get(id)?.name ?? asset.name, description: editsOf.get(id)?.description ?? asset.description }).execute();
          created += 1;
          marks.push({ assetId, flag: null, rationale: asset.rationale, itemId: id });
        }
        const holding = new Set((await trx.selectFrom('asset_holders').select('element_id').where('asset_id', '=', assetId).execute()).map((row) => row.element_id));
        let added = 0;
        // The holders the person named instead of the draft's, or the draft's. A reference to an element of the draft is linked when it is a node that is in the
        // model or in the request; a reference to an element of the threat model is linked, and the database refuses one that cannot hold an asset.
        const wanted: EditRef[] = editsOf.get(id)?.holders ?? asset.held_by.map((item) => ({ item }));
        for (const holderRef of wanted) {
          const holderItem = 'item' in holderRef ? holderRef.item : null;
          const element = refFrom(holderRef);
          if (element === null || (holderItem !== null && !NODE_TYPES.has(elementOf.get(holderItem)?.type ?? ''))) {
            if (holderItem !== null) unlinked.push({ asset_item_id: id, element_item_id: holderItem });
          } else if (!holding.has(element)) {
            await trx.insertInto('asset_holders').values({ threat_model_id: threatModelId, asset_id: assetId, element_id: element }).execute();
            holding.add(element);
            added += 1;
          }
        }
        if (matched(id) && added > 0) changed += 1;
        continue;
      }
      const assumption = assumptionOf.get(id);
      if (assumption !== undefined && !matched(id)) {
        const assumptionId = newId.get(id) as string;
        await trx.insertInto('assumptions').values({ id: assumptionId, threat_model_id: threatModelId, statement: editsOf.get(id)?.statement ?? assumption.statement }).execute();
        created += 1;
        marks.push({ assumptionId, flag: null, rationale: assumption.rationale, itemId: id });
      }
    }

    await writeProvenance(trx, threatModelId, accountId, marks);

    // The decisions, in one statement: what each item became and, for a created record, a link to it (FR-018).
    const link = (id: string, kind: 'element' | 'asset' | 'assumption'): string | null => {
      const owns = kind === 'element' ? elementOf.has(id) : kind === 'asset' ? assetOf.has(id) : assumptionOf.has(id);
      return owns ? (newId.get(id) ?? null) : null;
    };
    await sql`
      UPDATE draft_items i SET decision = 'accepted', decided_by = ${accountId}, decided_at = now(), outcome = v.outcome,
             element_id = v.element_id, asset_id = v.asset_id, assumption_id = v.assumption_id
      FROM unnest(${ids}::uuid[], ${ids.map((id) => (matched(id) ? 'matched' : 'created'))}::text[], ${ids.map((id) => link(id, 'element'))}::uuid[],
                  ${ids.map((id) => link(id, 'asset'))}::uuid[], ${ids.map((id) => link(id, 'assumption'))}::uuid[]) AS v(id, outcome, element_id, asset_id, assumption_id)
      WHERE i.id = v.id`.execute(trx);

    return { created, changed, unlinked_holders: unlinked };
  });
}
