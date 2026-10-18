import { z } from 'zod';

// What Scrylux reads of an OWASP Threat Dragon version 2 file (contracts/threat-dragon-mapping.md, research #7). Only the
// members the mapping uses are declared, with their types and generous caps. Every object is loose: Threat Dragon writes
// colours, line styles, z-order and more that Scrylux has no use for, so those are allowed, but they are bounded first by
// `checkBounds` and then never walked, stored, logged or echoed (`attrs` is typed `unknown` on purpose).

const NAME_CAP = 10_000;
const TEXT_CAP = 100_000;
const LIST_CAP = 100_000;

const name = z.string().max(NAME_CAP);
const text = z.string().max(TEXT_CAP).nullish();
const list = <T extends z.ZodType>(item: T) => z.array(item).max(LIST_CAP).nullish();
const loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);
const flag = z.boolean().nullish();

const Threat = loose({
  title: name,
  description: text,
  status: name.nullish(),
  severity: name.nullish(),
  type: name.nullish(),
  modelType: name.nullish(),
  mitigation: text,
  score: z.union([z.string().max(NAME_CAP), z.number()]).nullish(),
});

const CellData = loose({
  name: name.nullish(),
  description: text,
  outOfScope: flag,
  reasonOutOfScope: text,
  privilegeLevel: name.nullish(),
  protocol: name.nullish(),
  providesAuthentication: flag,
  isEncrypted: flag,
  storesCredentials: flag,
  isWebApplication: flag,
  isPublicNetwork: flag,
  isBidirectional: flag,
  isALog: flag,
  isSigned: flag,
  handlesCardPayment: flag,
  handlesGoodsOrServices: flag,
  storesInventory: flag,
  threats: list(Threat),
});

const point = loose({ x: z.number(), y: z.number() });
const end = loose({ cell: name.nullish() });

const Cell = loose({
  id: name,
  shape: name,
  position: point.nullish(),
  size: loose({ width: z.number(), height: z.number() }).nullish(),
  source: end.nullish(),
  target: end.nullish(),
  data: CellData.nullish(),
  attrs: z.unknown().optional(),
});

const Diagram = loose({
  title: name.nullish(),
  description: text,
  diagramType: name.nullish(),
  cells: z.array(Cell).max(LIST_CAP),
});

export const ThreatDragonFile = loose({
  version: name,
  summary: loose({ title: name.nullish(), description: text, owner: name.nullish() }).nullish(),
  detail: loose({
    contributors: list(loose({ name: name.nullish() }).nullable()),
    diagrams: z.array(Diagram).max(LIST_CAP),
  }),
});
export type ThreatDragonFile = z.infer<typeof ThreatDragonFile>;
