import { ELEMENT_FLAGS, type ElementType, type JsonValue } from '@scrylux/core';

// An element's `properties` as the editor works with them: tags, and flags that are yes (true) or no
// (false) when set and not assessed when absent (spec FR-015a). Anything else found in the stored object is
// "other": written before the vocabulary existed, shown read-only, and removed by the next change.

export type FlagState = 'yes' | 'no' | 'unset';

export interface SplitProperties {
  tags: string[];
  flags: Record<string, boolean>;
  // Names of what is stored but not part of the vocabulary for this type: "color", "flags.shiny".
  other: string[];
}

export function splitProperties(type: ElementType, properties: Record<string, unknown>): SplitProperties {
  const allowed = new Set<string>(ELEMENT_FLAGS[type]);
  const result: SplitProperties = { tags: [], flags: {}, other: [] };
  for (const [key, value] of Object.entries(properties)) {
    if (key === 'tags') {
      if (Array.isArray(value) && value.every((tag) => typeof tag === 'string')) result.tags = value;
      else result.other.push('tags');
    } else if (key === 'flags') {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        for (const [flag, state] of Object.entries(value)) {
          if (allowed.has(flag) && typeof state === 'boolean') result.flags[flag] = state;
          else result.other.push(`flags.${flag}`);
        }
      } else result.other.push('flags');
    } else result.other.push(key);
  }
  return result;
}

// The properties to store: a key with nothing in it is left out, so `{}` means "nothing assessed".
export function buildProperties({ tags, flags }: Pick<SplitProperties, 'tags' | 'flags'>): Record<string, JsonValue> {
  return {
    ...(tags.length > 0 ? { tags } : {}),
    ...(Object.keys(flags).length > 0 ? { flags } : {}),
  };
}

export const flagState = (value: boolean | undefined): FlagState => (value === undefined ? 'unset' : value ? 'yes' : 'no');

// Sets one flag, or clears it for not assessed.
export function withFlag(flags: Record<string, boolean>, key: string, state: FlagState): Record<string, boolean> {
  const rest = Object.fromEntries(Object.entries(flags).filter(([flag]) => flag !== key));
  return state === 'unset' ? rest : { ...rest, [key]: state === 'yes' };
}

// What a change of type does to the flags: those the new type has too are kept, and those it does not are
// dropped. `lost` is only the ones someone had set to yes or no: a flag nobody assessed costs nothing.
export function carryFlags(
  flags: Record<string, boolean>,
  nextType: ElementType,
): { kept: Record<string, boolean>; lost: string[] } {
  const allowed = new Set<string>(ELEMENT_FLAGS[nextType]);
  const kept: Record<string, boolean> = {};
  const lost: string[] = [];
  for (const [key, value] of Object.entries(flags)) {
    if (allowed.has(key)) kept[key] = value;
    else lost.push(key);
  }
  return { kept, lost };
}
