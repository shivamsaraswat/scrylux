import { randomUUID } from 'node:crypto';
import {
  MAX_ELEMENTS,
  nameIssues,
  type BoundaryLayout,
  type ElementType,
  type Impact,
  type ImportNote,
  type ImportSummary,
  type Likelihood,
  type Methodology,
  type MitigationStatus,
  type NameIssue,
  type NodeLayout,
  type StaleReason,
  type StrideCategory,
  type ThreatModelStatus,
  type ThreatStatus,
} from '@scrylux/core';
import { HttpError } from '../../v1/errors.js';

// What an import will create, before and after the rules across records are applied (data-model.md, "ImportPlan").
// One planner per format turns a parsed file into an ImportPlan whose rows carry the file's own ids; `checkPlan` then
// refuses what storage would refuse, with the place in the file, and gives every record a new id. A check and an
// import run the same functions on the same input, so their summaries cannot differ (research #6).

export interface PlanElement {
  // The file's id on the way in, a new UUID on the way out.
  id: string;
  // The record's place in the file, such as `file.elements.4`, for refusals.
  path: string;
  type: ElementType;
  name: string;
  properties: { tags?: string[]; flags?: Record<string, boolean> };
  layout: NodeLayout | BoundaryLayout | null;
  parent_boundary_id: string | null;
  source_element_id: string | null;
  target_element_id: string | null;
  // How deep a trust boundary is nested (0 at the top). Set by checkPlan; the writer inserts one depth at a time.
  depth: number;
}

export interface PlanThreat {
  id: string;
  path: string;
  element_id: string | null;
  category: StrideCategory;
  title: string;
  description: string;
  likelihood: Likelihood;
  impact: Impact;
  status: ThreatStatus;
  status_reason: string | null;
  // 'ai' never reaches a plan: the planners refuse it (FR-010).
  origin: 'manual' | 'rule';
  library_ref: string | null;
  stale: StaleReason | null;
}

export interface PlanMitigation {
  id: string;
  path: string;
  threat_id: string;
  description: string;
  status: MitigationStatus;
  external_ref: string | null;
}

export interface PlanModel {
  threatModel: { id: string; name: string; methodology: Methodology; status: ThreatModelStatus };
  // What is wrong with the name, set by checkPlan. A check reports it; the import refuses it.
  name_issue: NameIssue | null;
  elements: PlanElement[];
  threats: PlanThreat[];
  mitigations: PlanMitigation[];
}

export interface ImportPlan {
  models: PlanModel[];
  notes: ImportNote[];
}

export interface CheckContext {
  // The names the user chose, one per model. Without them each model keeps the name its file gave it.
  names?: readonly string[] | undefined;
  // The names of the project's threat models.
  existingNames: readonly string[];
  newId?: () => string;
}

const refuse = (message: string): HttpError => new HttpError(400, message);
const NODE_TYPES: ReadonlySet<ElementType> = new Set(['external_entity', 'process', 'data_store']);
const REASON_STATUSES: ReadonlySet<ThreatStatus> = new Set(['accepted', 'not_applicable']);

// Every record keeps its place in the plan; only ids and references change. Refusals come in the file's order, so the
// first problem a user fixes is the first one in the file.
function checkModel(model: PlanModel, newId: () => string): PlanModel {
  if (model.elements.length > MAX_ELEMENTS) {
    throw refuse(`file: a threat model can hold at most ${MAX_ELEMENTS.toLocaleString('en-US')} elements`);
  }

  const seen = new Set<string>();
  for (const row of [...model.elements, ...model.threats, ...model.mitigations]) {
    if (seen.has(row.id)) throw refuse(`${row.path}.id: must be different from every other id in the file`);
    seen.add(row.id);
  }

  const elements = new Map(model.elements.map((element) => [element.id, element]));
  for (const element of model.elements) checkElement(element, elements);
  const depths = boundaryDepths(model.elements, elements);

  const threats = new Map(model.threats.map((threat) => [threat.id, threat]));
  const ruleKeys = new Set<string>();
  for (const threat of model.threats) checkThreat(threat, elements, ruleKeys);
  for (const mitigation of model.mitigations) {
    if (!threats.has(mitigation.threat_id)) throw refuse(`${mitigation.path}.threat_id: must refer to a threat in this file`);
  }

  const elementIds = new Map(model.elements.map((element) => [element.id, newId()]));
  const threatIds = new Map(model.threats.map((threat) => [threat.id, newId()]));
  const mapped = (ids: Map<string, string>, id: string | null): string | null => (id === null ? null : (ids.get(id) ?? null));
  return {
    ...model,
    threatModel: { ...model.threatModel, id: newId() },
    elements: model.elements.map((element) => ({
      ...element,
      id: elementIds.get(element.id) as string,
      parent_boundary_id: mapped(elementIds, element.parent_boundary_id),
      source_element_id: mapped(elementIds, element.source_element_id),
      target_element_id: mapped(elementIds, element.target_element_id),
      depth: depths.get(element.id) ?? 0,
    })),
    threats: model.threats.map((threat) => ({ ...threat, id: threatIds.get(threat.id) as string, element_id: mapped(elementIds, threat.element_id) })),
    mitigations: model.mitigations.map((mitigation) => ({
      ...mitigation,
      id: newId(),
      threat_id: threatIds.get(mitigation.threat_id) as string,
    })),
  };
}

function checkElement(element: PlanElement, elements: ReadonlyMap<string, PlanElement>): void {
  const isFlow = element.type === 'data_flow';
  const { source_element_id: source, target_element_id: target } = element;
  if (isFlow ? source === null || target === null : source !== null || target !== null) {
    throw refuse(`${element.path}: a data flow needs source_element_id and target_element_id, and other element types must have neither`);
  }
  if (isFlow) {
    if (element.parent_boundary_id !== null) throw refuse(`${element.path}.parent_boundary_id: a data flow cannot have a parent_boundary_id`);
    if (source === target) throw refuse(`${element.path}: a data flow cannot start and end at the same element`);
    for (const [field, id] of [['source_element_id', source], ['target_element_id', target]] as const) {
      const end = id === null ? undefined : elements.get(id);
      if (end === undefined || !NODE_TYPES.has(end.type)) {
        throw refuse(`${element.path}.${field}: must refer to an external entity, process or data store in this file`);
      }
    }
    return;
  }
  if (element.parent_boundary_id !== null && elements.get(element.parent_boundary_id)?.type !== 'trust_boundary') {
    throw refuse(`${element.path}.parent_boundary_id: must refer to a trust boundary in this file`);
  }
}

// How deep each trust boundary sits, refusing nesting that loops back on itself. A boundary is reported when its own
// chain of parents returns to it; one that only leads into a loop is not, because a member of the loop is.
function boundaryDepths(list: readonly PlanElement[], elements: ReadonlyMap<string, PlanElement>): Map<string, number> {
  for (const element of list) {
    if (element.type !== 'trust_boundary') continue;
    const visited = new Set<string>([element.id]);
    for (let parent = element.parent_boundary_id; parent !== null; parent = elements.get(parent)?.parent_boundary_id ?? null) {
      if (parent === element.id) throw refuse(`${element.path}.parent_boundary_id: trust boundaries cannot contain each other in a cycle`);
      if (visited.has(parent)) break;
      visited.add(parent);
    }
  }
  const depths = new Map<string, number>();
  for (const element of list) {
    if (element.type !== 'trust_boundary') continue;
    let depth = 0;
    for (let parent = element.parent_boundary_id; parent !== null; parent = elements.get(parent)?.parent_boundary_id ?? null) depth += 1;
    depths.set(element.id, depth);
  }
  return depths;
}

function checkThreat(threat: PlanThreat, elements: ReadonlyMap<string, PlanElement>, ruleKeys: Set<string>): void {
  if (threat.element_id !== null && !elements.has(threat.element_id)) {
    throw refuse(`${threat.path}.element_id: must refer to an element in this file`);
  }
  if (threat.status_reason !== null && !REASON_STATUSES.has(threat.status)) {
    throw refuse(`${threat.path}.status_reason: can only be set on a threat that is accepted or not_applicable`);
  }
  if (threat.origin !== 'rule') {
    if (threat.stale !== null) throw refuse(`${threat.path}.stale: can only be set on a rule-generated threat`);
    return;
  }
  if (threat.element_id === null) throw refuse(`${threat.path}.element_id: a rule-generated threat needs an element`);
  if (threat.library_ref === null) throw refuse(`${threat.path}.library_ref: a rule-generated threat needs a library_ref`);
  const key = `${threat.element_id}\u0000${threat.library_ref}`;
  if (ruleKeys.has(key)) throw refuse(`${threat.path}: another rule-generated threat already has this element and rule`);
  ruleKeys.add(key);
}

// Applies the names and the rules across records. It returns a new plan, with new ids, nesting depths, the names the
// models will have and what is wrong with each, or throws a 400 naming the place in the file. A name issue is data,
// not a refusal: a check reports it, and `requireUsableNames` refuses it for the import.
export function checkPlan(plan: ImportPlan, context: CheckContext): ImportPlan {
  const count = plan.models.length;
  if (context.names !== undefined && context.names.length !== count) {
    throw refuse(`names: must have ${count} ${count === 1 ? 'entry' : 'entries'}, one per threat model in the file`);
  }
  const newId = context.newId ?? randomUUID;
  const models = plan.models.map((model) => checkModel(model, newId));
  const names = models.map((model, index) => (context.names?.[index] ?? model.threatModel.name).trim());
  const issues = nameIssues(names, context.existingNames);
  return {
    models: models.map((model, index) => ({
      ...model,
      threatModel: { ...model.threatModel, name: names[index] as string },
      name_issue: issues[index] ?? null,
    })),
    notes: plan.notes,
  };
}

// The import's extra step: a name with an issue is not created. A taken name is a 409, as creating a threat model
// answers; the rest are bad requests. `where` names the field the user can change.
export function requireUsableNames(plan: ImportPlan, namesGiven: boolean): void {
  plan.models.forEach((model, index) => {
    if (model.name_issue === null) return;
    const where = namesGiven || plan.models.length > 1 ? `names.${index}` : 'threat_model.name';
    switch (model.name_issue) {
      case 'taken':
        throw new HttpError(409, `${where}: a threat model with this name already exists in this project`);
      case 'empty':
        throw refuse(`${where}: must not be empty`);
      case 'too_long':
        throw refuse(`${where}: must be at most 200 characters`);
      case 'duplicate':
        throw refuse(`${where}: must differ from the other names in this file`);
    }
  });
}

export function summarize(plan: ImportPlan): ImportSummary {
  return {
    models: plan.models.map((model) => ({
      name: model.threatModel.name,
      name_issue: model.name_issue,
      status: model.threatModel.status,
      elements: model.elements.length,
      threats: model.threats.length,
      mitigations: model.mitigations.length,
    })),
    notes: plan.notes,
  };
}
