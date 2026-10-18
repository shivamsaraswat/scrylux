import { ElementRecord, MitigationRecord, ThreatModelRecord, ThreatRecord } from '@scrylux/core';
import type { Database } from '@scrylux/db';
import type { Transaction } from 'kysely';
import { kdb } from './db.js';

// What a report is built from: one threat model and everything in it, read in a single repeatable-read transaction
// so that all four reads see one state of the database (research #3). Read separately, a delete in between could
// leave a mitigation whose threat is not in the list, and "every threat and mitigation exactly once" (SC-002) would
// not hold. The transaction is also read only, so a report can never write.
export interface Snapshot {
  model: ThreatModelRecord;
  project: { name: string };
  elements: ElementRecord[];
  threats: ThreatRecord[];
  mitigations: MitigationRecord[];
}

export function withSnapshot<T>(read: (trx: Transaction<Database>) => Promise<T>): Promise<T> {
  return kdb.transaction().setIsolationLevel('repeatable read').setAccessMode('read only').execute(read);
}

// The threat model joined to its project is read first, so an unknown id answers null before anything else is read.
// Every row is parsed with the shared record schemas, as the list endpoints do, so a timestamp is the same text here
// as in the API and a stray column is an error, not a leak.
export async function readSnapshot(trx: Transaction<Database>, threatModelId: string): Promise<Snapshot | null> {
  const found = await trx
    .selectFrom('threat_models')
    .innerJoin('projects', 'projects.id', 'threat_models.project_id')
    .selectAll('threat_models')
    .select('projects.name as project_name')
    .where('threat_models.id', '=', threatModelId)
    .executeTakeFirst();
  if (found === undefined) return null;
  const { project_name, ...model } = found;

  const elements = await trx
    .selectFrom('elements')
    .selectAll()
    .where('threat_model_id', '=', threatModelId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const threats = await trx
    .selectFrom('threats')
    .selectAll()
    .where('threat_model_id', '=', threatModelId)
    .orderBy('created_at')
    .orderBy('id')
    .execute();
  const mitigations = await trx
    .selectFrom('mitigations')
    .innerJoin('threats', 'threats.id', 'mitigations.threat_id')
    .selectAll('mitigations')
    .where('threats.threat_model_id', '=', threatModelId)
    .orderBy('mitigations.created_at')
    .orderBy('mitigations.id')
    .execute();

  return {
    model: ThreatModelRecord.parse(model),
    project: { name: project_name },
    elements: ElementRecord.array().parse(elements),
    threats: ThreatRecord.array().parse(threats),
    mitigations: MitigationRecord.array().parse(mitigations),
  };
}
