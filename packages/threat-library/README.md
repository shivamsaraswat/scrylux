# @scrylux/threat-library

The STRIDE-per-element threat rules, as plain YAML files, and the small amount of code that checks them
and works out which threats apply to a diagram element.

A rule says: "for an element of this type, when these security flags are set like this, here is a
candidate threat, with a default description, a default likelihood and impact, and suggested
mitigations." Reading the rules needs no knowledge of the code. This package decides nothing about
your threat model: it answers one question, "which candidate threats apply to this element?". Turning
the answers into threats (the "Generate threats" action) is the rule engine's job, from Phase 2
Milestone 3.

Design notes: [`specs/phase-2/milestone-2-threat-library/`](../../specs/phase-2/milestone-2-threat-library/).

## Reading a rule

```text
rules/
├── external_entity/<id>.yaml
├── process/<id>.yaml
├── data_store/<id>.yaml
├── data_flow/<id>.yaml
├── ids.yaml        every rule id ever issued
└── retired.yaml    rules that were withdrawn
```

There is one rule per file, in the directory of the element type it is for, and the file is named after
the rule's `id`. Trust boundaries have no flags and STRIDE-per-element gives them no threats of their
own, so there is no directory for them.

This is a real rule, [`rules/data_flow/df-disclosure-plaintext-crossing.yaml`](rules/data_flow/df-disclosure-plaintext-crossing.yaml):

```yaml
id: df-disclosure-plaintext-crossing
element_type: data_flow
category: Information Disclosure
variant_group: df-plaintext-transit
title: "Data from {{source}} to {{target}} readable in transit across a trust boundary"
description: >-
  {{element}} carries data from {{source}} to {{target}} without encryption, and the connection
  leaves one trust zone for another. Anyone on the network path between the zones can read it.
likelihood: High
impact: High
when:
  flags:
    encrypted_in_transit: no
  flow:
    crosses_trust_boundary: yes
mitigations:
  - Encrypt the connection with TLS 1.2 or later and reject plaintext connections.
  - Authenticate the server certificate on the client side.
references:
  - CWE-319
  - CAPEC-94
examples:
  applies:
    - flags: { encrypted_in_transit: not_assessed }
      flow: { crosses_trust_boundary: yes, source_type: external_entity, target_type: process }
  does_not_apply:
    - flags: { encrypted_in_transit: yes }
      flow: { crosses_trust_boundary: yes, source_type: external_entity, target_type: process }
    - flow: { crosses_trust_boundary: no, source_type: process, target_type: process }
```

Read it as: *for a data flow that is not encrypted in transit and crosses a trust boundary, suggest an
Information Disclosure threat, High likelihood and High impact, with these two mitigations.*

### Fields

| Field | Meaning |
|---|---|
| `id` | The rule's permanent name. Lowercase letters, digits and single hyphens, at most 100 characters, and the same as the file name without `.yaml`. It becomes the threat's library reference, so it never changes and is never reused (see [Retiring a rule](#retiring-a-rule)). |
| `element_type` | `external_entity`, `process`, `data_store` or `data_flow`. Must match the directory. |
| `category` | One STRIDE category: Spoofing, Tampering, Repudiation, Information Disclosure, Denial of Service or Elevation of Privilege. Only the categories STRIDE-per-element allows for the element type (table below). |
| `title` | The threat's title, 1–200 characters. May contain placeholders. |
| `description` | The default description, 1–10,000 characters. May contain placeholders. |
| `likelihood`, `impact` | `Low`, `Medium` or `High`. Defaults: a user changes them per threat. |
| `variant_group` | Optional. A label shared by rules that are versions of one threat under different conditions. |
| `when` | Optional. When the rule applies (see below). No `when` means it applies to every element of its type. |
| `mitigations` | One to five suggested mitigations, each 1–10,000 characters, no two alike. |
| `references` | Optional, at most ten: `CWE-<number>`, `CAPEC-<number>` or an `https://` link. Informational only. |
| `examples` | At least one element the rule applies to, and, when the rule has conditions, at least one it does not apply to. The tests run every example. |

| Element type | Allowed categories |
|---|---|
| External entity | Spoofing, Repudiation |
| Process | all six |
| Data store | Tampering, Repudiation, Information Disclosure, Denial of Service |
| Data flow | Tampering, Information Disclosure, Denial of Service |

### When a rule applies (`when`)

`when.flags` lists flags of the element type, each required to be `yes` or `no`. The flags are the
fixed vocabulary of Phase 2 Milestone 1 (`packages/core/src/element-properties.ts`).

- **A flag that is "not assessed" counts as `no`.** Every flag starts as "not assessed", so a fresh
  diagram gets the threats for the unprotected case: an unassessed control is treated as missing.
- `yes` applies only when the flag is set to yes.
- **Every condition must hold.** There is no "or" and no nesting: write an alternative as a second
  rule.

Data-flow rules may also use `when.flow`, which are facts about the diagram that the flow's own
properties do not hold:

| Fact | Values |
|---|---|
| `crosses_trust_boundary` | `yes` or `no`. A flow crosses a trust boundary when its two ends are not inside exactly the same set of trust boundaries, nested ones counted. |
| `source_type` | `external_entity`, `process` or `data_store` |
| `target_type` | the same |

Nothing else about the diagram is available to a rule. Technology tags are free text and are never
used in conditions.

### Placeholders

A title or description may use `{{element}}` (the element's name) and, in data-flow rules, `{{source}}`
and `{{target}}` (the names of the two ends). They are replaced with the names exactly as stored, as
plain text. A name that looks like a placeholder is not expanded again. Any other `{{…}}` is an error.
Placeholders work only in the title and description: a mitigation is copied as written, so a `{{…}}` in
one is an error too.
If a title ends up over 200 characters, or a description over 10,000, it is cut to fit and ends in `…`.

### Variant groups

Some threats come in versions: the same unencrypted-flow threat is worse across a trust boundary than
inside one. Write each version as its own rule and give them the same `variant_group`. The checks make
sure that **at most one** rule of a group can apply to any element: every pair must require some flag or
flow fact to have different values. Rules in different groups, or in none, may all apply to one element.

### YAML pitfalls

The files are read as YAML 1.2, strictly.

- Write conditions as `yes` and `no`. They are read as text. An unquoted `true` or `false` is rejected
  with "write yes or no".
- Quote a title or description that starts with `{{`: unquoted, YAML reads it as a mapping.
- Write a description as a folded block scalar (`>-`): the lines are joined into one paragraph, and a
  blank line starts a new one. Use `|` only where the line breaks themselves matter.
- No anchors, aliases or custom tags, and no duplicate keys: a repeated flag is an error.
- A date such as `2026-10-08` is read as text and must be a real date.

## Adding or changing a rule

### Add a rule

1. **Choose the id.** Start with the element type (`ee-`, `p-`, `ds-` or `df-`), then the STRIDE
   category (`spoofing`, `tampering`, `repudiation`, `disclosure`, `dos`, `elevation`), then the
   concern, for example `ds-disclosure-unencrypted-at-rest`. **An id is permanent**: it is recorded on
   every threat the rule produces, so it is never renamed and never reused. Name the concern, not the
   wording, so you won't be tempted to rename it when you improve the text.
2. **Create the file** `rules/<element_type>/<id>.yaml`. Copy a rule of the same element type and
   change everything in it, so nothing is left over.
3. **Write original text.** Titles, descriptions and mitigations are written for Scrylux. Do not copy
   from other tools' templates or catalogs unless their licence allows it under Apache-2.0. You may cite
   CWE and CAPEC numbers in `references`.
4. **Write the examples.** Give at least one element the rule applies to and, if it has conditions, at
   least one it does not. Choose the near misses: the element that differs from a matching one by one
   flag. For a data flow, an example also says whether the flow crosses a trust boundary and what its
   two ends are. The tests run every example, so a condition that doesn't do what you meant fails here.
5. **Add the id to `rules/ids.yaml`**, in sorted order. The file lists every id ever issued.
6. **Run the checks** (below).

### Change a rule

| Change | How |
|---|---|
| Better wording, mitigations, references, defaults, examples or variant group | Edit the file. The `id` stays. |
| A different element type, category or conditions, so that the rule describes a different threat | Delete the file, add a [retirement record](#retiring-a-rule), and add a new rule with a new id (and add the new id to `ids.yaml`). The old id stays in `ids.yaml`. |
| Withdraw a rule | Delete the file and add a retirement record in the same change. Its id stays in `ids.yaml`. |

The checks cannot see a rule's previous version, so "a different threat gets a new id" is a review rule:
the pull request template asks about it.

### Run the checks

```sh
pnpm --filter @scrylux/threat-library test
```

They load every file in `rules/` and fail if anything is wrong. Each problem is one line:

```text
<file relative to rules/> (<rule id>): <field path>: <problem>
```

for example

```text
data_flow/df-x.yaml (df-x): when.flags.encrypted_at_rest: flag does not apply to data_flow
```

All problems are reported together, and nothing loads while any remain: a rule is never skipped. The
checks include:

- every field, its limits, and the STRIDE-per-element table;
- every flag a rule names exists for its element type;
- ids are unique, match the file name, and are never a retired id;
- titles are unique within an element type;
- rules in a variant group exclude each other;
- every example behaves as declared;
- `ids.yaml` and `retired.yaml` agree with the rules;
- the shipped catalog has 40–60 rules, and at least one for each of the 15 element type and category
  pairs STRIDE-per-element allows.

If the property vocabulary changes (a flag is renamed or removed in `packages/core`), every rule that
names the old flag fails the checks until it is updated.

## Retiring a rule

Never delete a rule outright. Its id is on every threat it produced, and the threats keep that reference
for good. To withdraw a rule, in one change:

1. delete `rules/<element_type>/<id>.yaml`;
2. add a record to `rules/retired.yaml`;
3. leave the id in `rules/ids.yaml`.

```yaml
retired:
  - id: p-old-rule
    retired_on: 2026-11-02
    reason: Split into separate internet and internal variants.
    replaced_by: [p-new-rule-internet, p-new-rule-internal]
```

- `retired_on` is a real date, written `YYYY-MM-DD`. `reason` is 1–200 characters.
- `replaced_by` is optional: up to ten ids of **active** rules that took over. If you later retire one
  of those, update this record in the same change; the checks fail otherwise.
- A retired id produces no threats, is never reused for another rule, and can still be looked up, so
  the rule engine can tell a threat whose rule was retired from one whose rule never existed.

**Renaming a rule is a retirement plus a new rule.** Retire the old id (pointing `replaced_by` at the
new one), add the new rule, and add the new id to `ids.yaml`. The old id stays listed. The checks
compare `ids.yaml` with the rules and the retirement records, so a rule that is renamed or deleted
without a record fails with the id that disappeared.

`ids.yaml` lists every id ever issued, one per line, in sorted order. Add an id when you add the rule;
never remove one. Removing a line together with its rule and record is the one change the checks cannot
see, so reviewers look for removed lines in this file.

## Using the library from code

```ts
import { shippedLibrary } from '@scrylux/threat-library';

const library = shippedLibrary(); // loads rules/ once; throws, listing every problem, if any rule is wrong

library.candidatesFor({
  type: 'data_flow',
  name: 'Card details',
  properties: { flags: { carries_sensitive_data: true } },
  flow: {
    crosses_trust_boundary: true, // the caller works this out from the diagram
    source_type: 'external_entity',
    target_type: 'process',
    source_name: 'Shopper',
    target_name: 'Checkout API',
  },
});

library.lookup('df-disclosure-plaintext-crossing'); // { status: 'active' | 'retired' | 'unknown', … }
library.coverage(); // active rules per element type and STRIDE category

// Why an active rule does not apply to an element: the conditions it does not meet, with what the rule
// requires and what the element has. Empty when the rule applies.
library.unmetConditions(
  { type: 'data_flow', name: 'Card details', properties: { flags: { encrypted_in_transit: true } }, flow },
  'df-disclosure-plaintext-crossing',
); // [{ fact: 'flag', flag: 'encrypted_in_transit', required: 'no', actual: 'yes' }]
```

`candidatesFor` is pure: the same element always gives the same candidates, in the order of the rule
ids, and it reads and writes nothing. It throws `LibraryInputError` for an element it cannot evaluate,
such as a flag its type does not have. The full interface is in
[`contracts/library-api.md`](../../specs/phase-2/milestone-2-threat-library/contracts/library-api.md).

`unmetConditions` uses the same comparisons as `candidatesFor`, so its answer cannot disagree with it. The
rule engine uses it to say why a generated threat went stale. It throws `LibraryInputError` for an id that
is not an active rule (use `lookup` for retired or unknown ids). See
[`contracts/library-api-additions.md`](../../specs/phase-2/milestone-3-rule-engine/contracts/library-api-additions.md).
