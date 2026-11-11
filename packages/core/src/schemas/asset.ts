import { z } from 'zod';
import { DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH, requiredText, timestamp, uuid } from '../fields.js';

// Assets and assumptions, two kinds of threat-model record (Phase 3 Milestone 5, data-model.md). They arrive by accepting a draft item or are
// created by hand, and every body is strict: a client can never send provenance (FR-017), and the threat model is in the path, not the body.

// The most assets, and the most assumptions, one threat model may hold (research #6). packages/db/migrations/019 enforces the same
// numbers; a test keeps them equal.
export const MAX_ASSETS = 200;
export const MAX_ASSUMPTIONS = 200;

// The most elements one asset may name as holders: a threat model holds at most 1,000 elements.
const MAX_HOLDERS = 1000;

const holderIds = uuid
  .array()
  .max(MAX_HOLDERS, `must have at most ${MAX_HOLDERS} items`)
  .refine((ids) => new Set(ids).size === ids.length, { message: 'must not repeat an element' })
  .meta({ description: 'The elements (processes, data stores and external entities of the same threat model) that store or carry the asset.' });

const AssetInputBase = z.strictObject({
  name: requiredText(NAME_MAX_LENGTH),
  description: requiredText(DESCRIPTION_MAX_LENGTH),
  holder_ids: holderIds,
});

export const AssetInput = AssetInputBase.extend({ holder_ids: holderIds.default([]) });
export type AssetInput = z.infer<typeof AssetInput>;

// `holder_ids` replaces the set. Built from the default-free base, as the other update inputs are.
export const AssetUpdate = AssetInputBase.partial().refine((changes) => Object.keys(changes).length > 0, { message: 'no updatable fields provided' });
export type AssetUpdate = z.infer<typeof AssetUpdate>;

export const AssetRecord = z.strictObject({
  id: uuid,
  threat_model_id: uuid,
  name: z.string().min(1),
  description: z.string().min(1),
  holder_ids: uuid.array(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type AssetRecord = z.infer<typeof AssetRecord>;

export const AssumptionInput = z.strictObject({ statement: requiredText(DESCRIPTION_MAX_LENGTH) });
export type AssumptionInput = z.infer<typeof AssumptionInput>;

export const AssumptionUpdate = AssumptionInput.refine((changes) => Object.keys(changes).length > 0, { message: 'no updatable fields provided' });
export type AssumptionUpdate = z.infer<typeof AssumptionUpdate>;

export const AssumptionRecord = z.strictObject({
  id: uuid,
  threat_model_id: uuid,
  statement: z.string().min(1),
  created_at: timestamp,
  updated_at: timestamp,
});
export type AssumptionRecord = z.infer<typeof AssumptionRecord>;
