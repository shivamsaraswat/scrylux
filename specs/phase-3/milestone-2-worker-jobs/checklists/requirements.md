# Specification Quality Checklist: Worker and Jobs

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-10-31
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- 2026-10-31 (iteration 1): one open question, which job kind Milestone 2 ships (US6, FR-090). It appears as two
  markers for the same question. Every other item passes.
- 2026-10-31 (iteration 2): Q1 = A. The only job kind is a provider check that any signed-in person starts from the
  UI, sending Milestone 1's fixed check request through the worker (US6, FR-090 to FR-093). FR-080 now records that
  any signed-in account can make the provider spend through it. Recorded under Clarifications. All items pass.
- 2026-10-31 (iteration 3, accuracy fixes, no new decision): FR-042's worst case now counts every call Milestone 1's
  layer can make for one request (M1 FR-010), and Assumptions require the default caps to fit one provider check.
  FR-071 says it replaces M1's missing-key start-up rule for the API only, and the check command's assumption says to
  run it with the worker's environment. FR-080 and Assumptions record that caps bound one job, not spend over time,
  which stays an open risk until Phase 6. All items pass.
- 2026-10-31 (planning): the maintainer chose Scrylux's own jobs table over pg-boss, and the worker as a second entry
  point of the API application. FR-042 now counts only billable calls, the queue assumption and the edge case on
  changed caps were corrected, all recorded under Clarifications (during planning). The spec was re-checked and all
  items still pass.
- 2026-11-01 (after `/speckit-analyze`): FR-030 and FR-062 cover a running job whose worker died (shown as such,
  in the no-worker notice, cancelled at once once its loss is known), with a new edge case; FR-021 counts runs, and a
  hand-back does not count; FR-004 lists the health port and the cooldown. Recorded under Clarifications. All items
  still pass.
- The constitution's terms (`/health`, `/api/v1`, the OpenAPI document, `schema_migrations`, stdout logging,
  `docs/install.md`, `docs/threat-model/`, the compose files) are the rules this milestone must keep, not a choice of
  implementation, as in Milestone 1's spec. plan.md's former queue (pg-boss) is named only in Assumptions, to record
  the planning decision that replaced it.
- Items marked incomplete require spec updates before `/speckit-clarify` or `/speckit-plan`.
