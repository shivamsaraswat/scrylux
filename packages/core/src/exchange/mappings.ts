// The words and constants an import matches against and an export writes (research #21). Data only: no function, no
// logic, so it can be read and reviewed without reading the planners, and docs/formats/ prints every entry (a test
// keeps the two equal). Matching ignores case, and for states and categories everything that is not a letter.

// --- OTM -------------------------------------------------------------------------------------------------------

// How an OTM component's `type` becomes a Scrylux node type (contracts/otm-mapping.md, "Component types"). Read in
// this order: an exact spelling, then an external-entity keyword, then a data-store keyword. Anything else is a
// process, with a note.
export const OTM_COMPONENT_TYPES = {
  exact: {
    external_entity: ['external-entity', 'external_entity', 'externalentity'],
    process: ['process'],
    data_store: ['data-store', 'data_store', 'datastore'],
  },
  externalEntity: ['external', 'client', 'user', 'actor', 'browser', 'third-party', 'thirdparty', 'partner'],
  dataStore: ['database', 'db', 'store', 'storage', 'bucket', 'queue', 'cache', 'table', 'file'],
} as const;

// The states of an OTM threat reference and of a mitigation reference, as letters only (contracts/otm-mapping.md,
// "States"). A state in none of these gives the default, with a note.
export const OTM_THREAT_STATES = {
  open: ['exposed', 'expose', 'open', 'new'],
  mitigated: ['mitigated', 'mitigate'],
  accepted: ['accepted', 'accept'],
  not_applicable: ['notapplicable', 'na', 'hidden'],
} as const;

export const OTM_MITIGATION_STATES = {
  implemented: ['implemented'],
  verified: ['verified'],
  proposed: ['required', 'recommended', 'proposed', 'planned'],
} as const;

// What Scrylux's OTM export writes where OTM requires a value Scrylux doesn't have (contracts/otm-mapping.md,
// "Export"). 50 is the middle of OTM's trust scale and 0 claims no risk reduction.
export const OTM_EXPORT = {
  trustRating: 50,
  riskReduction: 0,
  risk: { Low: 25, Medium: 50, High: 75 },
  componentTypes: { external_entity: 'external-entity', process: 'process', data_store: 'data-store' },
  threatStates: { open: 'exposed', mitigated: 'mitigated', accepted: 'accepted', not_applicable: 'not-applicable' },
  mitigationStates: { proposed: 'required', implemented: 'implemented', verified: 'implemented' },
  outsideZone: { id: 'scrylux-outside', name: 'Outside any trust boundary' },
} as const;

// --- Threat Dragon ----------------------------------------------------------------------------------------------

// A cell's `shape` (contracts/threat-dragon-mapping.md, "Cells").
export const TD_SHAPES = {
  nodes: { actor: 'external_entity', process: 'process', store: 'data_store' },
  flow: 'flow',
  boundaryBox: 'trust-boundary-box',
  boundaryLine: 'trust-boundary-curve',
  textBlock: 'td-text-block',
} as const;

// A threat's `status`, as letters only (contracts/threat-dragon-mapping.md, "Threats"). The `unmapped` words are
// statuses Scrylux has no equivalent for: they import as open, and the note names the original.
export const TD_STATUSES = {
  open: ['open'],
  mitigated: ['mitigated'],
  accepted: ['accepted'],
  not_applicable: ['na', 'notapplicable'],
  unmapped: ['transferred', 'avoided', 'eliminated'],
} as const;

// A threat's `severity` becomes the impact. `known` words with no mapping (`tba`) are named in the note; any other
// value is "other".
export const TD_SEVERITIES = {
  impact: { High: 'high', Medium: 'medium', Low: 'low' },
  unmapped: ['tba'],
} as const;

// `[shape, property, Scrylux flag]`: a `true` sets the flag; a `false` leaves it not assessed, because Threat Dragon
// can't tell "no" from "not considered" (contracts/threat-dragon-mapping.md, "Properties").
export const TD_FLAG_PAIRS = [
  ['actor', 'providesAuthentication', 'authenticated'],
  ['store', 'isEncrypted', 'encrypted_at_rest'],
  ['store', 'storesCredentials', 'stores_sensitive_data'],
  ['flow', 'isEncrypted', 'encrypted_in_transit'],
] as const;

// Technology tags taken from Threat Dragon: a flow's `protocol`, and a process that is a web application.
export const TD_TAGS = {
  flowProtocol: 'protocol',
  webApplication: { property: 'isWebApplication', tag: 'web application' },
} as const;

// --- Notes --------------------------------------------------------------------------------------------------------

// The `detail` of a `not_imported.field` note: the field an import had no place for (data-model.md, "Note kinds").
export const NOT_IMPORTED_FIELDS = [
  'description',
  'owner',
  'ownerContact',
  'contributors',
  'tags',
  'outOfScope',
  'privilegeLevel',
  'bidirectional',
  'trustRating',
  'shape',
  'isPublicNetwork',
  'isBidirectional',
  'isALog',
  'isSigned',
  'handlesCardPayment',
  'handlesGoodsOrServices',
  'storesInventory',
  'cwes',
  'likelihoodComment',
  'impactComment',
  'score',
  'riskReduction',
  'attributes',
  'unreferencedMitigation',
  'providesAuthentication',
  'isEncrypted',
  'storesCredentials',
  'isWebApplication',
  'categories',
] as const;
export type NotImportedField = (typeof NOT_IMPORTED_FIELDS)[number];

// Presentation data and identifiers that are ignored without a note (FR-016).
export const IGNORED_PRESENTATION = {
  otm: ['id', 'representation id', 'representation name', 'representation size of a component', 'trust zone type'],
  threatDragon: [
    'attrs',
    'zIndex',
    'vertices',
    'connector',
    'visible',
    'size of a node',
    'thumbnail',
    'placeholder',
    'hasOpenThreats',
    'number',
    'threatId',
    'modelType',
    'version',
    'id',
  ],
} as const;
