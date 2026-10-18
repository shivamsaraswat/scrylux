import type { ThreatGenerationResult } from '@scrylux/core';
import { sql } from 'kysely';
import { shippedLibrary } from '@scrylux/threat-library';
import { kdb } from '../db.js';
import { lockModel } from '../v1/element-writes.js';
import { HttpError } from '../v1/errors.js';
import { planGeneration, type ExistingRuleThreat } from './plan.js';

// Rows per statement, chosen to stay far below Postgres's 65,535-parameter limit: 11 columns for a
// threat, 4 for a mitigation (research #7).
const THREAT_CHUNK = 1_000;
const MITIGATION_CHUNK = 5_000;
// Stale changes per statement: each row carries a whole reason, so keep the single parameter modest.
const STALE_CHUNK = 1_000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let at = 0; at < items.length; at += size) result.push(items.slice(at, at + size));
  return result;
}

// One "Generate threats" run, all in one transaction, so a failure anywhere leaves nothing (FR-004).
// The model lock is the one every element write takes first, so overlapping runs queue, element writes
// wait for the run, and the run reads the diagram as the last committed writer left it (FR-005,
// research #6).
export async function runGeneration(threatModelId: string): Promise<ThreatGenerationResult> {
  // Loaded before the transaction opens, so a library that fails to load writes nothing (research #11).
  const library = shippedLibrary();

  return kdb.transaction().execute(async (trx) => {
    if (!(await lockModel(trx, threatModelId))) throw new HttpError(404, 'Threat model not found');

    const elements = await trx
      .selectFrom('elements')
      .select(['id', 'type', 'name', 'properties', 'source_element_id', 'target_element_id', 'parent_boundary_id'])
      .where('threat_model_id', '=', threatModelId)
      .execute();

    // Only generated threats are read (FR-006): a manual threat is never matched, changed or flagged.
    const stored = await trx
      .selectFrom('threats')
      .select(['id', 'element_id', 'library_ref', 'stale'])
      .where('threat_model_id', '=', threatModelId)
      .where('origin', '=', 'rule')
      .execute();
    const ruleThreats: ExistingRuleThreat[] = stored.map(({ element_id, library_ref, ...rest }) => {
      // Storage guarantees both for a rule threat (threats_rule_link); anything else is a bug.
      if (element_id === null || library_ref === null) throw new Error('a rule threat lacks its element or rule');
      return { ...rest, element_id, library_ref };
    });

    const plan = planGeneration({ elements, ruleThreats, library });

    for (const chunk of chunks(plan.creates, THREAT_CHUNK)) {
      await trx
        .insertInto('threats')
        .values(chunk.map(({ mitigations: _mitigations, ...threat }) => ({ ...threat, threat_model_id: threatModelId })))
        .execute();
    }
    for (const chunk of chunks(plan.creates.flatMap((threat) => threat.mitigations), MITIGATION_CHUNK)) {
      await trx.insertInto('mitigations').values(chunk).execute();
    }

    // The last write of a run (a failure here must leave nothing behind, and the atomicity test fails
    // exactly here). The rows travel as ONE bound parameter, `${…}` below being Kysely's `$1`, never SQL
    // text, so constitution Principle I holds. It is JSON.stringify(chunk), not the array: node-postgres
    // would send an array as a Postgres array literal, which the ::jsonb cast refuses. Narrowed to this
    // model's generated threats, so even a wrong id could not touch anything else.
    for (const chunk of chunks(plan.staleChanges, STALE_CHUNK)) {
      await sql`
        UPDATE threats AS t SET stale = v.stale
        FROM jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS v(id uuid, stale jsonb)
        WHERE t.id = v.id AND t.threat_model_id = ${threatModelId} AND t.origin = 'rule'`.execute(trx);
    }

    return plan.counts;
  });
}
