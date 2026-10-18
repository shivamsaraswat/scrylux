## Summary

<!-- What changed and why, in a few bullets. Link the issue (`Closes #123`) or the spec (`specs/phase-N/milestone-M-name/`). -->

## How this satisfies Principles I–VI

See the [constitution](https://github.com/shivamsaraswat/scrylux/blob/main/.specify/memory/constitution.md) for what each principle requires.

<!-- One row per principle of the constitution (.specify/memory/constitution.md). "N/A" is fine, with a reason. -->

| Principle | How |
|---|---|
| **I. Secure coding** | |
| **II. Test-first** | |
| **III. Simplicity** | |
| **IV. Maintainability** | |
| **V. Least privilege / Threat Model** | |
| **VI. AI output is a draft** | |

## Security implications

<!-- A new or changed entry point, authentication, input validation, secrets or permissions? Describe
     each, including anything this broadens. Write "None" if there are none. -->

## Threat Model

<!-- Updated: which section of the constitution's Threat Model changed. Or "No change", and why
     (the change adds no asset, entry point or trust boundary). If you added an asset, an entry point or a
     trust boundary, or retired or changed a threat-library rule: was Scrylux's own threat model
     (`docs/threat-model/`, see its README) updated in the same change? -->

## Testing

<!-- The tests you wrote first, and what they cover. Which of these you ran locally:
     pnpm typecheck, pnpm lint, pnpm test, pnpm test:e2e, docker build . -->

<!-- Threat rules: if this changes `packages/threat-library/rules/`, did an existing rule's
     `element_type`, `category` or `when` change? If so, retire it and add a new rule under a new id
     instead (spec FR-021). Did any line disappear from `rules/ids.yaml`? None may (FR-019a). The
     checks cannot see either, so review enforces both. Write "N/A" if rules are untouched. -->
