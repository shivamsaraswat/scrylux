import {
  TD_FLAG_PAIRS,
  TD_SEVERITIES,
  TD_SHAPES,
  TD_STATUSES,
  TD_TAGS,
  type ElementType,
  type Impact,
  type ImportNote,
  type MitigationStatus,
  type StrideCategory,
  type ThreatDragonFile,
  type ThreatStatus,
} from '@scrylux/core';
import { assignBoxes, placeBoundary, placeNode, relativeTo, type Rect } from './geometry.js';
import { adapters, hasText, letters, matchStride, note } from './notes.js';
import { refuse } from './parse-with.js';
import type { ImportPlan, PlanElement, PlanMitigation, PlanModel, PlanThreat } from './plan.js';

// A Threat Dragon version 2 file as a plan (contracts/threat-dragon-mapping.md): one model per diagram (FR-013a). Every
// threat is manual; everything the file holds that Scrylux has no place for is listed in the notes (FR-016).

type Diagram = ThreatDragonFile['detail']['diagrams'][number];
type Cell = Diagram['cells'][number];
type TdThreat = NonNullable<NonNullable<Cell['data']>['threats']>[number];

// Threat Dragon's booleans that say something about a cell. A `true` that is not mapped to a flag or a tag is listed.
const BOOLEAN_PROPERTIES = [
  'providesAuthentication',
  'isEncrypted',
  'storesCredentials',
  'isWebApplication',
  'isPublicNetwork',
  'isBidirectional',
  'isALog',
  'isSigned',
  'handlesCardPayment',
  'handlesGoodsOrServices',
  'storesInventory',
] as const;

const NODE_TYPES = TD_SHAPES.nodes;
type NodeShape = keyof typeof NODE_TYPES;
const isNodeShape = (shape: string): shape is NodeShape => Object.hasOwn(NODE_TYPES, shape);

const IMPACTS: Record<string, Impact> = Object.fromEntries(Object.entries(TD_SEVERITIES.impact).map(([impact, word]) => [word, impact as Impact]));
const STATUSES: Record<string, ThreatStatus> = Object.fromEntries(
  (['open', 'mitigated', 'accepted', 'not_applicable'] as const).flatMap((status) => TD_STATUSES[status].map((word): [string, ThreatStatus] => [word, status])),
);

const capitalised = (word: string): string => word.charAt(0).toUpperCase() + word.slice(1);

export function planThreatDragon(file: ThreatDragonFile): ImportPlan {
  const notes: ImportNote[] = [];
  const { add, field, nameOf, longText, tagsOf } = adapters(notes);
  const diagrams = file.detail.diagrams;
  const fileTitle = file.summary?.title ?? '';

  // The file's own fields that say something about the model, noted once, as the first model's.
  const modelLabel = fileTitle;
  if (hasText(file.summary?.description)) field('file.summary', modelLabel, 'description');
  if (hasText(file.summary?.owner)) field('file.summary', modelLabel, 'owner');
  if ((file.detail.contributors ?? []).length > 0) field('file.detail', modelLabel, 'contributors');

  const models: PlanModel[] = diagrams.map((diagram, index) => {
    const base = `file.detail.diagrams.${index}`;
    const diagramTitle = diagram.title ?? '';
    const name = diagrams.length === 1 ? fileTitle : [fileTitle, diagramTitle].filter((part) => part.trim() !== '').join(' – ');
    if (hasText(diagram.description)) field(base, name, 'description');

    const elements: PlanElement[] = [];
    const threats: PlanThreat[] = [];
    const mitigations: PlanMitigation[] = [];
    const cells = diagram.cells;
    const cellPath = (at: number): string => `${base}.cells.${at}`;
    const byId = new Map(cells.map((cell) => [cell.id, cell]));

    // Which box each box and node is drawn in, worked out from where things are (Threat Dragon records no parent).
    const rectOf = (cell: Cell): Rect | null =>
      cell.position && cell.size ? { x: cell.position.x, y: cell.position.y, width: cell.size.width, height: cell.size.height } : null;
    const boxes = cells.flatMap((cell) => (cell.shape === TD_SHAPES.boundaryBox && rectOf(cell) !== null ? [{ id: cell.id, rect: rectOf(cell) as Rect }] : []));
    const nodes = cells.flatMap((cell) => {
      if (!isNodeShape(cell.shape) || !cell.position) return [];
      const size = cell.size ?? { width: 0, height: 0 };
      return [{ id: cell.id, point: { x: cell.position.x + size.width / 2, y: cell.position.y + size.height / 2 } }];
    });
    const { boxParent, nodeParent } = assignBoxes(boxes, nodes);
    const boxPosition = new Map(boxes.map((box) => [box.id, { x: box.rect.x, y: box.rect.y }]));
    const kind = letters(diagram.diagramType ?? '');

    // Flags and tags from a cell's properties; a `true` with no place is listed.
    const propertiesOf = (cell: Cell, path: string, label: string, tags: string[]): PlanElement['properties'] => {
      const data = cell.data ?? {};
      const flags: Record<string, boolean> = {};
      for (const property of BOOLEAN_PROPERTIES) {
        if (data[property] !== true) continue;
        const pair = TD_FLAG_PAIRS.find(([shape, name]) => shape === cell.shape && name === property);
        if (pair) flags[pair[2]] = true;
        else if (cell.shape === 'process' && property === TD_TAGS.webApplication.property) tags.push(TD_TAGS.webApplication.tag);
        else field(path, label, property);
      }
      const kept = tagsOf(tags, path, label);
      return { ...(kept.length > 0 ? { tags: kept } : {}), ...(Object.keys(flags).length > 0 ? { flags } : {}) };
    };
    const contentOf = (cell: Cell, path: string, label: string): void => {
      const data = cell.data ?? {};
      if (hasText(data.description)) field(path, label, 'description');
      if (hasText(data.privilegeLevel)) field(path, label, 'privilegeLevel');
      if (data.outOfScope === true) field(path, label, 'outOfScope');
    };

    // A threat becomes a threat of `elementId` (or of the model). Threats of a diagram that is not STRIDE, or of no STRIDE
    // category, are left out and listed.
    const addThreats = (cell: Cell, at: number, elementId: string | null, moved: boolean): void => {
      (cell.data?.threats ?? []).forEach((raw: TdThreat, position) => {
        const path = `${cellPath(at)}.data.threats.${position}`;
        const label = raw.title.trim() === '' ? undefined : raw.title.trim();
        const typeKind = kind === '' ? letters(raw.modelType ?? '') : kind;
        const category: StrideCategory | null = typeKind !== '' && typeKind !== 'stride' ? null : matchStride(raw.type ?? '');
        if (category === null) {
          add(note(path, 'not_imported.threat_category', label));
          return;
        }
        if (moved) add(note(path, 'moved.model_level', label));
        const severity = letters(raw.severity ?? '');
        const impact = IMPACTS[severity];
        if (impact === undefined) {
          add(note(path, 'mapped.severity', label, (TD_SEVERITIES.unmapped as readonly string[]).includes(severity) ? severity.toUpperCase() : 'other'));
        }
        const statusWord = letters(raw.status ?? '');
        const status = STATUSES[statusWord] ?? 'open';
        if (statusWord !== '' && STATUSES[statusWord] === undefined) {
          add(note(path, 'mapped.status', label, (TD_STATUSES.unmapped as readonly string[]).includes(statusWord) ? capitalised(statusWord) : 'other'));
        }
        if (raw.score !== null && raw.score !== undefined && String(raw.score).trim() !== '') field(path, label, 'score');
        const id = `t:${cell.id}#${position}`;
        threats.push({
          id,
          path,
          element_id: elementId,
          category,
          title: nameOf(raw.title, path, 'threat'),
          description: longText(raw.description ?? '', path, label, 'description'),
          likelihood: 'Medium',
          impact: impact ?? 'Medium',
          status,
          status_reason: null,
          origin: 'manual',
          library_ref: null,
          stale: null,
        });
        if (hasText(raw.mitigation)) {
          const mitigationStatus: MitigationStatus = status === 'mitigated' ? 'implemented' : 'proposed';
          mitigations.push({
            id: `m:${cell.id}#${position}`,
            path,
            threat_id: id,
            description: longText(raw.mitigation, path, label, 'mitigation'),
            status: mitigationStatus,
            external_ref: null,
          });
        }
      });
    };

    const elementId = (cell: Cell): string => `e:${cell.id}`;
    cells.forEach((cell, at) => {
      const path = cellPath(at);
      const label = hasText(cell.data?.name) ? cell.data.name.trim() : undefined;
      const shown = label ?? '';

      if (cell.shape === TD_SHAPES.boundaryLine) {
        add(note(path, 'not_imported.boundary_line', label));
        addThreats(cell, at, null, true);
        return;
      }
      if (cell.shape === TD_SHAPES.textBlock) {
        add(note(path, 'not_imported.text_block', label));
        return;
      }

      if (cell.shape === TD_SHAPES.flow) {
        for (const [fieldName, end] of [['source', cell.source], ['target', cell.target]] as const) {
          const ref = end?.cell;
          if (hasText(ref) && !byId.has(ref)) throw refuse(`${path}.${fieldName}.cell: must refer to a cell in this diagram`);
        }
        const source = cell.source?.cell;
        const target = cell.target?.cell;
        const attached = hasText(source) && hasText(target) && source !== target && isNodeShape(byId.get(source)?.shape ?? '') && isNodeShape(byId.get(target)?.shape ?? '');
        if (!attached) {
          add(note(path, 'not_imported.dangling_flow', label));
          addThreats(cell, at, null, true);
          return;
        }
        contentOf(cell, path, shown);
        const tags = hasText(cell.data?.protocol) ? [cell.data.protocol] : [];
        elements.push({
          id: elementId(cell),
          path,
          type: 'data_flow',
          name: nameOf(cell.data?.name, path, 'data_flow'),
          properties: propertiesOf(cell, path, shown, tags),
          layout: null,
          parent_boundary_id: null,
          source_element_id: `e:${source}`,
          target_element_id: `e:${target}`,
          depth: 0,
        });
        addThreats(cell, at, elementId(cell), false);
        return;
      }

      const isBox = cell.shape === TD_SHAPES.boundaryBox;
      if (!isBox && !isNodeShape(cell.shape)) {
        field(path, label, 'shape');
        addThreats(cell, at, null, true);
        return;
      }
      const type: ElementType = isBox ? 'trust_boundary' : NODE_TYPES[cell.shape as NodeShape];
      const parentId = (isBox ? boxParent : nodeParent).get(cell.id) ?? null;
      const parent = parentId === null ? null : (boxPosition.get(parentId) ?? null);
      const position = cell.position ? relativeTo(cell.position, parent) : null;
      const placed = isBox ? placeBoundary(position, cell.size) : placeNode(position);
      if (placed.adjusted !== null) add(note(path, 'adjusted.layout', label, placed.adjusted));
      contentOf(cell, path, shown);
      elements.push({
        id: elementId(cell),
        path,
        type,
        name: nameOf(cell.data?.name, path, type),
        properties: isBox ? {} : propertiesOf(cell, path, shown, []),
        layout: placed.layout,
        parent_boundary_id: parentId === null ? null : `e:${parentId}`,
        source_element_id: null,
        target_element_id: null,
        depth: 0,
      });
      addThreats(cell, at, elementId(cell), false);
    });

    return { threatModel: { id: `model-${index}`, name, methodology: 'STRIDE', status: 'draft' }, name_issue: null, elements, threats, mitigations };
  });

  return { models, notes };
}

