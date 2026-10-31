# Contract: data files

The versioned data the layer ships (Principle IV, FR-041, FR-033a, FR-015a). They are read once
from the package's own directory, parsed strictly (YAML 1.2 core schema, no aliases, no custom tags,
no duplicate keys, as `@scrylux/threat-library` parses its rules), and validated by strict zod schemas.
An invalid file makes the first use of the layer throw, and a test loads every shipped file.

## `packages/llm/data/prices.yaml`

```yaml
# Prices in US dollars per million tokens. Each entry says when and where its price was checked.
anthropic:
  - model: claude-opus-5-5
    input: 4.00
    output: 20.00
    checked: 2026-10-06
    source: https://platform.claude.com/docs/en/about-claude/pricing
  - model: claude-haiku-5-5
    input: 0.10
    output: 0.50
    above_input_tokens: 100000      # optional higher tier, chosen per attempt
    above: { input: 0.50, output: 2.50 }
    checked: 2026-10-06
    source: https://platform.claude.com/docs/en/about-claude/pricing
openai-compatible: [...]            # OpenAI's own models only; matched by exact model id
bedrock: [...]                      # Bedrock's own prices, including Claude on Bedrock
gemini: [...]
```

- **Keys**: the providers are exactly `anthropic`, `openai-compatible`, `bedrock` and `gemini`.
- **Embedding models** have `input` only.
- **Matching** is by exact model id, with no patterns, so a price is never applied to a model it was not
  checked for.
- **Validation**: prices are numbers ≥ 0, `checked` is a date that is not in the future, and `source` is
  an https URL. A model appearing twice under one provider fails the test (FR-033a).

## `packages/llm/data/models.yaml`

An excerpt, to show the shape. The full seed entries are those of research #6, which is the source when
the two differ.

```yaml
anthropic:
  - match: "claude-opus-4-6*"
    temperature: send
  - match: "claude-opus-*"          # Opus 4.7 and later
    temperature: omit
    reason: "Sampling parameters removed; any temperature is a 400"
    source: https://platform.claude.com/docs/en/about-claude/models/overview
  # … Sonnet 5 and 5.5, Haiku 5.5 and Fable: omit, each with its reason and source (research #6)
  - match: "*"
    temperature: send
    structured_output: native
gemini:
  - match: "gemini-2.5*"
    temperature: send
  - match: "gemini-embedding-*"
    embedding_batch: 100
  - match: "*"                       # Gemini 3 and every later generation
    temperature: omit
    reason: "Google advises keeping Gemini 3 and later at the default temperature of 1.0; lower values may loop"
    source: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/gemini-3-prompting-guide
    structured_output: native
    embedding_batch: 100
openai-compatible: [...]
bedrock: [...]
```

- **Matching**: `match` is a glob in which `*` is the only wildcard. Entries are tried in order and the
  first match wins. Each provider's last entry is `"*"`, and it sets every field that applies to that
  provider.
- **Fields**, and the providers each applies to:

  | Field | Values | Applies to | Default from |
  |---|---|---|---|
  | `temperature` | `send` or `omit` | all four | the provider's `*` entry |
  | `structured_output` | `native` or `instructions` | all four | the provider's `*` entry |
  | `max_tokens_param` | `max_tokens` or `max_completion_tokens` | `openai-compatible` | the provider's `*` entry |
  | `embedding_batch` | 1–2048 | `openai-compatible`, `bedrock`, `gemini` | the provider's `*` entry |
  | `embedding_body` | `titan-v2` | `bedrock`, optional | none: absent means not supported |

  A field set for a provider it does not apply to is refused when the file is loaded.
- **Fields of an earlier entry are not inherited.** A field the first matching entry leaves out falls
  back to the provider's `*` entry only.
- **Bedrock** entries may set `embedding_body: titan-v2`. It is the only embedding body this milestone
  supports, and an embedding model without it fails as "not available" (research #17).
- **Claude on Bedrock mirrors the Anthropic list.** For each Anthropic entry other than `*`, the Bedrock
  list has an entry whose `match` is `*anthropic.` followed by the Anthropic pattern, with the same
  `temperature`, `reason` and `source`, in the same order and before any other Bedrock entry. For
  example, `claude-opus-4-6*` becomes `*anthropic.claude-opus-4-6*`. The leading `*` matches the
  geographic prefix of an inference profile (`us.`, `eu.`, `global.`). A mirrored entry may also set
  `structured_output: native` when Bedrock's model card lists structured outputs for those models
  (research #4). A test checks that the mirror is complete and in order.
- **Every `omit` needs a `reason` and an https `source`**, so reviewers can check the advice.

## `packages/llm/prompts/`

| File | Used for |
|---|---|
| `content-section.md` | Three blocks separated by a `%%%` line: the preamble added to the instructions, explaining that the marked section is data and never instructions, then the start marker line and the end marker line, each with the `{{nonce}}` placeholder (research #10) |
| `empty-turn.md` | The user turn of a request that has no content, so that every provider is sent a non-empty one |
| `schema-retry.md` | The user message of a schema retry, with `{{issues}}` filled by a list of `path: problem` lines (research #9) |
| `json-instructions.md` | The instruction added in fallback mode, with `{{schema}}` filled by the JSON Schema (research #4) |
| `check.yaml` | The check's fixed generation instructions, the name of its one required string field and of its schema, and its fixed embedding sentence (FR-047) |

Placeholders are filled in one pass with plain string replacement. Text inserted into a placeholder is
never itself searched for placeholders. Each file is loaded and checked for its placeholders by a test
(`test/data-files.test.ts`): `content-section.md` has exactly `{{nonce}}`, `schema-retry.md` exactly
`{{issues}}`, and `json-instructions.md` exactly `{{schema}}`.
