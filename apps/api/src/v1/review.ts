import { DecisionResult, DraftDecision, ProvenanceRecord } from '@scrylux/core';
import { kdb } from '../db.js';
import { readDraft } from '../extract-system/draft.js';
import { readReview } from '../review/compare.js';
import { readProvenance } from '../review/provenance.js';
import { accept, reject, undecide } from '../review/decide.js';
import { HttpError, orNotFound } from './errors.js';
import { LIST_ORDER_DESCRIPTION, defineOperation, type Operation } from './operation.js';
import { logDecision } from './write-log.js';

// The review routes (Phase 3 Milestone 5, contracts/http-api.md): decide the items of a draft, and read where the records an accept created came from.
// Any signed-in account can decide any threat model's draft: there are no roles before Phase 6, and the threat model says so (FR-026, FR-027). The API
// sends no request to a provider: a review reads a draft that is stored (FR-024). No error answer and no log line holds any text of the draft (SC-006).

export const reviewOperations: Operation<unknown>[] = [
  defineOperation({
    method: 'post',
    path: '/threat-models/:id/draft/decisions',
    operationId: 'decideDraft',
    summary: 'Decide items of a threat model’s draft: accept them into the threat model, reject them, or return rejected ones to undecided',
    description:
      'A request names the draft the reviewer saw and the items; an accept also carries, for each item, the comparison the page showed and any edits, and no content. The server builds each ' +
      'record from the stored draft, all together or none: an element, an asset or an assumption is created, or, for an element or an asset that is already in ' +
      'the threat model, only what it lacked is added. 409: the draft was replaced or discarded, an item was already decided or is out of date, an element needs ' +
      'another that is not in the threat model, or a limit would be passed.',
    body: { name: 'DraftDecision', schema: DraftDecision },
    response: { name: 'DecisionResult', schema: DecisionResult },
    status: 200,
    errors: [400, 404, 409],
    handler: async ({ id, body, accountId }) => {
      const result = body.action === 'accept' ? await accept(id, accountId, body) : body.action === 'reject' ? await reject(id, accountId, body) : await undecide(id, accountId, body);
      const draft = await readDraft(kdb, id);
      if (draft === undefined) throw new HttpError(409, 'This draft was replaced or discarded');
      logDecision(accountId, body.action, id, { items: body.items.length, created: result.created, changed: result.changed });
      return { draft: { ...draft, review: await readReview(kdb, draft) }, ...result };
    },
  }),
  defineOperation({
    method: 'get',
    path: '/threat-models/:id/provenance',
    operationId: 'listProvenance',
    summary: 'Where the records an accept created, and the flags it set, came from',
    description:
      `${LIST_ORDER_DESCRIPTION} One row for each element, asset or assumption an accept created and one for each flag it set on an element, with the rationale, who accepted it and when, ` +
      'and its citations as a draft shows them: the quote is read from its chunk, and a citation whose source was deleted has no chunk and no quote. A record that a person created, or ' +
      'imported, has none.',
    response: { name: 'ProvenanceRecord', schema: ProvenanceRecord, list: true },
    status: 200,
    errors: [400, 404],
    handler: async ({ id }) => {
      orNotFound(await kdb.selectFrom('threat_models').select('id').where('id', '=', id).executeTakeFirst(), 'Threat model');
      return readProvenance(kdb, id);
    },
  }),
];
