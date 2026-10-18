import { MIN_BOUNDARY_SIZE, NOTE_KINDS, type ImportNote, type NotImportedField, type NoteKind } from '@scrylux/core';

// The words of the import summary (contracts/web-ui.md). Everything an import leaves out or changes is a note of one of
// these kinds, and each has a fixed heading, so what the user is told does not depend on the file. Typed by core's list
// of kinds, so a kind without words is a type error here.

export const NOTE_HEADINGS: Record<NoteKind, string> = {
  'not_imported.boundary_line': 'Trust boundary lines (not imported)',
  'not_imported.text_block': 'Text blocks (not imported)',
  'not_imported.dangling_flow': 'Flows not attached to two elements (not imported)',
  'not_imported.asset': 'Assets (not imported)',
  'not_imported.representation': 'Other representations (not imported)',
  'not_imported.threat_category': 'Threats with no STRIDE category (not imported)',
  'not_imported.field': 'Fields with no place in a threat model (not imported)',
  'moved.model_level': 'Threats moved to the model, because their element was not imported',
  'moved.nearest_zone': 'Components inside components (placed in the nearest trust zone)',
  'mapped.component_type': 'Components with a type Scrylux does not have (imported as process)',
  'mapped.status': 'Statuses Scrylux does not have (imported with the default)',
  'mapped.severity': 'Severities or likelihoods that were missing or unknown (imported as Medium)',
  'mapped.risk_clamped': 'Risk values outside 0 to 100 (limited to that range)',
  'adjusted.shortened': 'Text shortened to fit',
  'adjusted.unnamed': 'Items with no name (given a placeholder name)',
  'adjusted.tags': 'Tags merged, shortened or limited',
  'adjusted.layout': 'Positions Scrylux could not hold',
};

// What a `not_imported.field` note's `detail` names, in words. Typed by core's list of fields, so a field an import can list
// cannot ship without words.
const FIELDS: Record<NotImportedField, string> = {
  description: 'description',
  owner: 'owner',
  ownerContact: 'owner contact',
  contributors: 'contributors',
  tags: 'tags',
  outOfScope: 'marked out of scope',
  privilegeLevel: 'privilege level',
  bidirectional: 'two-way flow',
  trustRating: 'trust rating',
  shape: 'unknown kind of shape',
  isPublicNetwork: 'crosses a public network',
  isBidirectional: 'two-way flow',
  isALog: 'holds logs',
  isSigned: 'uses signatures',
  handlesCardPayment: 'handles card payments',
  handlesGoodsOrServices: 'part of a retail site',
  storesInventory: 'stores inventory',
  cwes: 'CWEs',
  likelihoodComment: 'comment on the likelihood',
  impactComment: 'comment on the impact',
  score: 'score',
  riskReduction: 'risk reduction',
  attributes: 'the other tool’s own data',
  unreferencedMitigation: 'mitigation that no threat refers to',
  providesAuthentication: 'provides authentication',
  isEncrypted: 'encrypted',
  storesCredentials: 'stores credentials',
  isWebApplication: 'web application',
  categories: 'other categories (Scrylux keeps one STRIDE category)',
};

const SHORTENED: Record<string, string> = { name: 'name', description: 'description', mitigation: 'mitigation text' };

// What was done to one item, when the heading does not already say, or null.
export function noteDetail(item: ImportNote): string | null {
  const { detail } = item;
  if (detail === undefined) return null;
  switch (item.kind) {
    case 'not_imported.field':
      return Object.hasOwn(FIELDS, detail) ? FIELDS[detail as NotImportedField] : null;
    case 'adjusted.layout':
      return detail === 'enlarged' ? `enlarged to ${MIN_BOUNDARY_SIZE} × ${MIN_BOUNDARY_SIZE}` : 'left for the canvas to place';
    case 'mapped.severity':
      return detail === 'null' ? 'no value' : detail === 'other' ? 'unrecognised value' : detail;
    case 'mapped.status':
      return detail === 'other' ? 'unrecognised status' : detail;
    case 'adjusted.shortened':
      return SHORTENED[detail] ?? null;
    default:
      return null;
  }
}

// The kinds present in `notes`, in the order of core's list, each with its items in the file's order.
export function groupNotes(notes: readonly ImportNote[]): { kind: NoteKind; items: ImportNote[] }[] {
  return NOTE_KINDS.flatMap((kind) => {
    const items = notes.filter((item) => item.kind === kind);
    return items.length === 0 ? [] : [{ kind, items }];
  });
}
