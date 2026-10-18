import { z } from 'zod';
import { IMPACTS, LIKELIHOODS, METHODOLOGIES, MITIGATION_STATUSES, THREAT_MODEL_STATUSES, THREAT_ORIGINS, THREAT_STATUSES } from '../enums.js';
import { StaleReason } from '../schemas/stale.js';
import { SCRYLUX_FORMAT_VERSION, formatVersionMessage } from './formats.js';

// What Scrylux reads of an Open Threat Model 0.2.0 file (contracts/otm-mapping.md, research #7). Only the members the
// mapping uses are declared, with their types and generous caps, so one value cannot dominate. Every object is loose:
// other tools write members Scrylux has no use for, so those are allowed, but they are bounded first by `checkBounds`
// and then never walked, stored, logged or echoed. `attributes` is typed `unknown` on purpose, and only the Scrylux
// parts of it are parsed, strictly, by `OtmScrylux` below and only for a file Scrylux wrote.

const NAME_CAP = 10_000;
const TEXT_CAP = 100_000;
const LIST_CAP = 100_000;

const name = z.string().max(NAME_CAP);
const text = z.string().max(TEXT_CAP).nullish();
const list = <T extends z.ZodType>(item: T) => z.array(item).max(LIST_CAP).nullish();
const tags = list(z.string().max(NAME_CAP).nullable());
const loose = <T extends z.ZodRawShape>(shape: T) => z.looseObject(shape);

const parent = loose({ trustZone: name.nullish(), component: name.nullish() }).nullish();

const representation = loose({
  representation: name,
  id: name.nullish(),
  position: loose({ x: z.number(), y: z.number() }).nullish(),
  size: loose({ width: z.number(), height: z.number() }).nullish(),
});

const mitigationReference = loose({ mitigation: name.nullish(), state: name.nullish() });
const threatReference = loose({ threat: name, state: name.nullish(), mitigations: list(mitigationReference.nullable()) });

const TrustZone = loose({
  id: name,
  name,
  type: name.nullish(),
  description: text,
  risk: loose({ trustRating: z.number().nullish() }).nullish(),
  parent,
  representations: list(representation.nullable()),
  attributes: z.unknown().optional(),
});

const Component = loose({
  id: name,
  name,
  type: name,
  description: text,
  parent,
  representations: list(representation.nullable()),
  threats: list(threatReference.nullable()),
  tags,
  attributes: z.unknown().optional(),
});

const Dataflow = loose({
  id: name,
  name,
  description: text,
  bidirectional: z.boolean().nullish(),
  source: name,
  destination: name,
  threats: list(threatReference.nullable()),
  tags,
  attributes: z.unknown().optional(),
});

const Threat = loose({
  id: name,
  name,
  description: text,
  categories: list(name.nullable()),
  cwes: list(name.nullable()),
  risk: loose({
    likelihood: z.number().nullish(),
    likelihoodComment: text,
    impact: z.number().nullish(),
    impactComment: text,
  }).nullish(),
  tags,
  attributes: z.unknown().optional(),
});

const Mitigation = loose({
  id: name,
  name,
  description: text,
  riskReduction: z.number().nullish(),
  attributes: z.unknown().optional(),
});

export const OtmFile = loose({
  otmVersion: name,
  project: loose({
    name,
    id: name,
    description: text,
    owner: text,
    ownerContact: text,
    tags,
    attributes: z.unknown().optional(),
  }),
  representations: list(loose({ id: name.nullish(), name: name.nullish(), type: name.nullish() }).nullable()),
  assets: list(loose({ id: name.nullish(), name: name.nullish() }).nullable()),
  trustZones: list(TrustZone),
  components: list(Component),
  dataflows: list(Dataflow),
  threats: list(Threat),
  mitigations: list(Mitigation),
});
export type OtmFile = z.infer<typeof OtmFile>;

// What Scrylux's own OTM export writes in `attributes.scrylux` of each object (contracts/otm-mapping.md, "Export"). A
// file marked as written by Scrylux is read from these, strictly: any other key, or a value outside its vocabulary,
// refuses the file. The values are then checked again, by field, by the Scrylux file's own schema.
const nodeLayout = z.strictObject({ x: z.number(), y: z.number() });
const boundaryLayout = z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const flags = z.record(z.string(), z.boolean());

export const OtmScrylux = {
  project: z.strictObject({
    format_version: z.literal(SCRYLUX_FORMAT_VERSION, { error: (issue) => formatVersionMessage(issue.input) }),
    exported_at: z.string(),
    status: z.enum(THREAT_MODEL_STATUSES),
    methodology: z.enum(METHODOLOGIES),
  }),
  // The synthetic zone for elements outside every boundary, or a trust boundary.
  zone: z.union([
    z.strictObject({ outside: z.literal(true) }),
    z.strictObject({ layout: boundaryLayout.nullable(), parent_boundary_id: name.nullable() }),
  ]),
  component: z.strictObject({
    type: z.enum(['external_entity', 'process', 'data_store']),
    flags,
    layout: nodeLayout.nullable(),
    parent_boundary_id: name.nullable(),
  }),
  dataflow: z.strictObject({ flags }),
  threat: z.strictObject({
    element_id: name.nullable(),
    likelihood: z.enum(LIKELIHOODS),
    impact: z.enum(IMPACTS),
    status: z.enum(THREAT_STATUSES),
    status_reason: z.string().nullable(),
    origin: z.enum(THREAT_ORIGINS),
    library_ref: z.string().nullable(),
    stale: StaleReason.nullable(),
  }),
  mitigation: z.strictObject({ threat_id: name, status: z.enum(MITIGATION_STATUSES), external_ref: z.string().nullable() }),
} as const;
