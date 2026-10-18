import { ThreatModelRecord, type ImportSummary } from '@scrylux/core';
import { kdb } from '../../db.js';
import { orNotFound } from '../../v1/errors.js';
import { checkPlan, requireUsableNames, summarize, type ImportPlan, type PlanElement } from './plan.js';

// Rows per statement, chosen to stay far below Postgres's 65,535-parameter limit: 9 columns for an element, 13 for a
// threat, 5 for a mitigation (as rule-engine/run.ts does).
const ELEMENT_CHUNK = 1_000;
const THREAT_CHUNK = 1_000;
const MITIGATION_CHUNK = 5_000;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let at = 0; at < items.length; at += size) result.push(items.slice(at, at + size));
  return result;
}

// What a check says: the summary a real import would give, with each model's name issue reported rather than refused.
// It reads the project's threat model names and nothing else, takes no lock and writes nothing, so it is exactly the
// first half of `runImport` (research #6, FR-006b).
export async function checkImport(projectId: string, plan: ImportPlan, names?: readonly string[]): Promise<ImportSummary> {
  orNotFound(await kdb.selectFrom('projects').select('id').where('id', '=', projectId).executeTakeFirst(), 'Project');
  const existing = await kdb.selectFrom('threat_models').select('name').where('project_id', '=', projectId).execute();
  return summarize(checkPlan(plan, { names, existingNames: existing.map((row) => row.name) }));
}

// The import, all or nothing in one transaction. The project is locked FOR KEY SHARE, so a project deleted meanwhile
// makes the import wait and then fail, and not create models in a project that is gone. The names are read inside the
// transaction and the plan is checked against them again, so a name taken since the check is refused with a 409 and a
// name taken after it is caught by the unique index (research #6).
//
// Rows go in dependency order, one statement per level, because the element trigger reads a row's parent and the ends
// of a flow and Postgres does not promise the order in which one statement's rows are processed (research #10).
export async function runImport(
  projectId: string,
  plan: ImportPlan,
  names?: readonly string[],
): Promise<{ threatModels: ThreatModelRecord[]; summary: ImportSummary }> {
  return kdb.transaction().execute(async (trx) => {
    orNotFound(await trx.selectFrom('projects').select('id').where('id', '=', projectId).forKeyShare().executeTakeFirst(), 'Project');
    const existing = await trx.selectFrom('threat_models').select('name').where('project_id', '=', projectId).execute();
    const checked = checkPlan(plan, { names, existingNames: existing.map((row) => row.name) });
    requireUsableNames(checked, names !== undefined);

    const threatModels: ThreatModelRecord[] = [];
    for (const model of checked.models) {
      const { id, name, methodology, status } = model.threatModel;
      const inserted = await trx.insertInto('threat_models').values({ id, project_id: projectId, name, methodology, status }).returningAll().executeTakeFirstOrThrow();
      threatModels.push(ThreatModelRecord.parse(inserted));

      const insertElements = async (rows: readonly PlanElement[]): Promise<void> => {
        for (const chunk of chunks(rows, ELEMENT_CHUNK)) {
          await trx
            .insertInto('elements')
            .values(
              chunk.map((row) => ({
                id: row.id,
                threat_model_id: id,
                type: row.type,
                name: row.name,
                properties: row.properties,
                layout: row.layout,
                source_element_id: row.source_element_id,
                target_element_id: row.target_element_id,
                parent_boundary_id: row.parent_boundary_id,
              })),
            )
            .execute();
        }
      };
      const boundaries = model.elements.filter((row) => row.type === 'trust_boundary');
      for (let depth = 0; boundaries.some((row) => row.depth >= depth); depth += 1) {
        await insertElements(boundaries.filter((row) => row.depth === depth));
      }
      await insertElements(model.elements.filter((row) => row.type !== 'trust_boundary' && row.type !== 'data_flow'));
      await insertElements(model.elements.filter((row) => row.type === 'data_flow'));

      for (const chunk of chunks(model.threats, THREAT_CHUNK)) {
        await trx
          .insertInto('threats')
          .values(
            chunk.map((row) => ({
              id: row.id,
              threat_model_id: id,
              element_id: row.element_id,
              category: row.category,
              title: row.title,
              description: row.description,
              likelihood: row.likelihood,
              impact: row.impact,
              status: row.status,
              status_reason: row.status_reason,
              origin: row.origin,
              library_ref: row.library_ref,
              stale: row.stale,
            })),
          )
          .execute();
      }
      for (const chunk of chunks(model.mitigations, MITIGATION_CHUNK)) {
        await trx
          .insertInto('mitigations')
          .values(
            chunk.map((row) => ({ id: row.id, threat_id: row.threat_id, description: row.description, status: row.status, external_ref: row.external_ref })),
          )
          .execute();
      }
    }
    return { threatModels, summary: summarize(checked) };
  });
}
