# Contract: configuration

The environment variables the layer reads, and the rules `parseLlmConfig` applies. Every one is
added to the table in `docs/install.md` (Principle IV, FR-011). Unset and empty are the same.
Messages name the variable and never echo a value.

## Variables

| Variable | Applies to | Required | Default | Meaning |
|---|---|---|---|---|
| `LLM_PROVIDER` | generation | no | — (AI off) | `anthropic`, `openai-compatible`, `bedrock` or `gemini` |
| `LLM_MODEL` | generation | with a provider | — | The provider's model id. For Azure, the deployment name |
| `LLM_BASE_URL` | generation | with `openai-compatible` | — | e.g. `https://api.openai.com/v1`, `https://<resource>.openai.azure.com/openai/v1/`, `http://ollama:11434/v1` |
| `LLM_API_KEY` | generation | with `anthropic` or `gemini`; optional with `openai-compatible` | — | Also read from the secrets-manager secret |
| `LLM_LOCAL` | generation | no | `false` | `true` declares an `openai-compatible` provider local |
| `LLM_REGION` | generation | with `bedrock` | — | AWS region, e.g. `us-east-1` |
| `EMBEDDING_PROVIDER` | embeddings | no | — (embeddings off) | `openai-compatible`, `bedrock` or `gemini` |
| `EMBEDDING_MODEL` | embeddings | with a provider | — | e.g. `text-embedding-3-small`, `nomic-embed-text`, `amazon.titan-embed-text-v2:0`, `gemini-embedding-001` |
| `EMBEDDING_BASE_URL` | embeddings | with `openai-compatible` | — | As `LLM_BASE_URL` |
| `EMBEDDING_API_KEY` | embeddings | as `LLM_API_KEY` | the generation key, when provider and base address are the same | Also read from the secrets-manager secret |
| `EMBEDDING_LOCAL` | embeddings | no | `false` | As `LLM_LOCAL` |
| `EMBEDDING_REGION` | embeddings | with `bedrock` | — | As `LLM_REGION` |
| `LLM_TIMEOUT` | both | no | `300s` | Time limit per attempt: a whole number and `s` or `m`, from `10s` to `60m` |
| `LLM_PRICE_INPUT` | generation | no | — | US dollars per million input tokens. It overrides the price list. Set it with `LLM_PRICE_OUTPUT` |
| `LLM_PRICE_OUTPUT` | generation | no | — | US dollars per million output tokens |
| `EMBEDDING_PRICE_INPUT` | embeddings | no | — | US dollars per million input tokens |

Bedrock's credentials are not Scrylux variables. They come from the AWS SDK's default chain: the
instance or task role, or the standard `AWS_*` variables.

## Rules (each failure stops startup, FR-006)

**Order.** `parseLlmConfig` throws on the first failure, checked in this order, so each case has one
expected message:

- **First**, generation (`LLM_*`), then embeddings (`EMBEDDING_*`). For each: rule 1; rule 2; rule 3;
  then each required setting that is missing, in the table's order (`*_MODEL`, `*_BASE_URL`,
  `*_API_KEY`, `*_REGION`), with the message `<VAR> must be set when <PROVIDER_VAR> is <provider>`; then
  `*_LOCAL`'s value (rule 6), because the rule for the address depends on it; then rules 4, 5 and 8 in
  number order; then the operation's prices (rule 10).
- **Then** rule 9 (`LLM_TIMEOUT`).
- **Last**, rule 11.

A message may repeat a provider name once it is one of the accepted names (FR-006). It never repeats
anything else the operator set.

1. A `*_PROVIDER` that is not one of the accepted names fails, and the message lists the accepted names.
   `anthropic` is not accepted for `EMBEDDING_PROVIDER` (FR-002).
2. Any other `LLM_*` setting, except `LLM_TIMEOUT`, without `LLM_PROVIDER` fails ("set LLM_PROVIDER, or
   remove LLM_MODEL"), so a half-made configuration is never silently ignored. The same holds for
   `EMBEDDING_*`.
3. A setting that does not apply to the chosen provider fails, for example `LLM_REGION` with
   `anthropic` or `LLM_BASE_URL` with `gemini`.
4. `*_MODEL` must be 1–200 printable characters with no whitespace.
5. `*_BASE_URL` must parse as an absolute URL with no query and no fragment.
   - It must use `https`.
   - It may use `http` only when `*_LOCAL=true` (FR-003a). The message then says that a hosted provider
     needs `https` and that a local one must be declared with `*_LOCAL=true`.
   - Credentials in the URL are accepted and treated as a secret. `fetch` refuses an address that carries
     them, so the OpenAI-compatible adapter takes them out of the address and sends them as HTTP Basic
     authentication when there is no API key. When there is a key, the key is used and the credentials are
     dropped. They are never shown or logged.
6. `*_LOCAL` must be `true` or `false`. `true` with any provider but `openai-compatible` fails (FR-044a).
7. A key is required for `anthropic` and `gemini`. It is not accepted for `bedrock`, so a key set by
   mistake for Bedrock fails.
8. `*_REGION` must look like an AWS region (`^[a-z]{2}(-[a-z]+)+-\d$`).
9. `LLM_TIMEOUT` must be within its range and format.
10. A price must be a decimal number of at least 0 with at most 6 decimal places. `LLM_PRICE_INPUT`
    and `LLM_PRICE_OUTPUT` must be set together (FR-033b). A price set without its provider fails
    (rule 2).

11. When either provider is set, none of the variables the provider SDKs read on their own may be set
    (FR-043a). The list lives in `config.ts` as `SDK_ENV_VARIABLES`:
    - every `ANTHROPIC_*`, `OPENAI_*` and `AZURE_OPENAI_*` variable;
    - `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL`,
      `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_CLOUD_PROJECT`,
      `GOOGLE_CLOUD_LOCATION` and `GOOGLE_SDK_NODE_LOGGING` (a logging switch the scan found);
    - `AWS_BEDROCK_BASE_URL`;
    - while either operation uses `bedrock`: `AWS_ENDPOINT_URL` and every `AWS_ENDPOINT_URL_*`
      variable (for example `AWS_ENDPOINT_URL_BEDROCK_RUNTIME`). They change the address a request
      goes to. With no Bedrock provider they are accepted, because the API's secrets-manager client may
      use them.

    The message names the first one found and says to remove it.

    **The AWS exemption** is a list of names in `config.ts`, `AWS_EXEMPT_VARIABLES`, never a prefix. It
    holds the variables of the AWS default credential chain, profile and region:
    `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_CREDENTIAL_EXPIRATION`,
    `AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_CONFIG_FILE`, `AWS_SHARED_CREDENTIALS_FILE`,
    `AWS_ROLE_ARN`, `AWS_ROLE_SESSION_NAME`, `AWS_WEB_IDENTITY_TOKEN_FILE`,
    `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, `AWS_CONTAINER_CREDENTIALS_FULL_URI`,
    `AWS_CONTAINER_AUTHORIZATION_TOKEN`, `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`,
    `AWS_EC2_METADATA_DISABLED`, `AWS_EC2_METADATA_V1_DISABLED`, `AWS_EC2_METADATA_SERVICE_ENDPOINT`,
    `AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE` and `AWS_BEARER_TOKEN_BEDROCK`. Bedrock uses the AWS
    default chain by design (FR-004). **The final list, settled by the scan on 2026-10-21**, is in
    `AWS_EXEMPT_VARIABLES` in `config.ts`. It also holds the variables that tune AWS's own client:
    retry settings that an explicit option overrides (`AWS_MAX_ATTEMPTS`, tested), the authentication-scheme
    preference, FIPS and dual-stack endpoints (another endpoint of the same AWS region, not another host),
    and the user-agent application id.

    **The test.** `test/sdk-env.test.ts` in `packages/llm` reads the installed SDK packages and their
    whole production dependency tree (so `google-auth-library`, which `@google/genai` uses, is
    included). It collects every string literal that looks like a vendor variable name (`ANTHROPIC_`,
    `OPENAI_`, `AZURE_OPENAI_`, `GEMINI_`, `GOOGLE_`, `GCLOUD_`, `AWS_`), not only `readEnv` and `getEnv`
    calls,
    because the AWS SDK reads variables through configuration selectors. It fails when a name is
    neither refused nor exempt, so an SDK update that starts reading a new variable is caught. A name
    found that is not an environment variable is added to an ignore list in the test, with a comment
    saying where it occurs.

    Each adapter also sets explicitly every client option that has an environment default: key,
    `authToken: null`, base address, `organization: null`, `project: null`, logging off, Gemini's
    `vertexai: false`. Option names are taken from each installed package's type definitions.

## The secrets-manager secret

The existing `DB_SECRET_ID` secret may also hold `LLM_API_KEY` and `EMBEDDING_API_KEY`. When present,
they override the environment's values, as the secret's other keys do (FR-008). Both are added to the
list of keys in `docs/install.md`.

## Hosted or local (FR-044, FR-044a)

| Provider | Hosted |
|---|---|
| `anthropic`, `bedrock`, `gemini` | always |
| `openai-compatible` | unless `*_LOCAL=true` |

## Startup (apps/api)

After `config.load()`, `server.ts` calls `parseLlmConfig` with the environment merged with the
secret's two keys.

- **On `LlmConfigError`** it prints
  `Startup failed: invalid AI provider configuration: <message>` and exits 1.
- **On success** it prints one line, with no model name, address or key:
  `AI providers: generation <provider|off> (<hosted|local>), embeddings <provider|off> (<hosted|local>)`.
  For example `AI providers: generation anthropic (hosted), embeddings off`.
