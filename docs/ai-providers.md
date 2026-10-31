# AI providers

Scrylux can ask a language model for structured answers and for embeddings. You choose where the model runs, with environment values, and you can run without one. This page says how to set each provider up, what leaves your install, and what a request costs. The variables are listed in [Install and run](install.md#environment-variables).

No Scrylux feature sends your content to a model yet. This release builds the layer, and the [check](#checking-the-configuration) is the only thing that sends a request, with fixed text and none of your data.

## Running without AI

Set none of the variables below, and Scrylux behaves as it did before: it starts, answers `/health`, and never connects to a model provider. The log says `AI providers: generation off, embeddings off`.

If you set a provider, Scrylux checks every setting it needs when it starts, and refuses to start with a message that names the variable. It never contacts the provider at start, so a provider that is down, or a local model that starts later, does not stop Scrylux. Embeddings are optional: you can set a generation provider and no embedding provider.

## Hosted or local

Data sent to a **hosted** provider leaves your install. Data sent to a **local** one stays in it. Scrylux reports one of the two for each provider it uses, and a later release will show it in the interface.

- Anthropic, Amazon Bedrock and Gemini are always hosted.
- An `openai-compatible` provider is hosted unless you say it is local with `LLM_LOCAL=true` (or `EMBEDDING_LOCAL=true`). Scrylux cannot check that statement: a private address can be a proxy to a hosted service, so the address alone proves nothing. Declare it local only when you run the model yourself.
- A hosted provider must be reached over `https`. A plain `http://` address is accepted only for a provider declared local, so a key never crosses a network in the clear.
- An address may carry credentials (`https://user:pass@host/v1`), as one behind a proxy with basic authentication does. Scrylux sends them as HTTP Basic authentication when there is no API key, and never shows them. If you also set a key, the key is used and the credentials in the address are dropped.

## Setting up each provider

Put the values in the environment of the `app` service, for example in a `.env` file next to the compose file (never commit it), or export them in your shell. [`.env.example`](../.env.example) lists them all.

### Anthropic

```sh
LLM_PROVIDER=anthropic
LLM_MODEL=claude-sonnet-5-5
LLM_API_KEY=<your key>
```

Anthropic offers no embeddings. For them, set an `EMBEDDING_PROVIDER` of another kind.

### OpenAI

```sh
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=<a model from your account>
LLM_API_KEY=<your key>

# Optional; the same key is used for the same address.
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=https://api.openai.com/v1
EMBEDDING_MODEL=text-embedding-3-small
```

### Azure OpenAI

Use the resource's v1 address, and the **name of your deployment** as the model. Scrylux cannot tell which model a deployment runs, so it cannot look up its price: set one if you want a cost (see [Prices](#prices)).

```sh
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://<resource>.openai.azure.com/openai/v1/
LLM_MODEL=<your deployment name>
LLM_API_KEY=<your key>
```

### Ollama (local)

Run Ollama on the machine that runs Scrylux, or on another one you control.

```sh
ollama pull llama3.2
ollama pull nomic-embed-text
```

```sh
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://host.docker.internal:11434/v1
LLM_MODEL=llama3.2
LLM_LOCAL=true

EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_BASE_URL=http://host.docker.internal:11434/v1
EMBEDDING_MODEL=nomic-embed-text
EMBEDDING_LOCAL=true
```

The compose files map `host.docker.internal` to the host, on Linux as well. If Ollama runs in a container of the same compose project, use its service name instead.

Ollama can shorten an input that is longer than its context window instead of refusing it, and Scrylux cannot see that happen. Set the context length high enough for what you send, with `OLLAMA_CONTEXT_LENGTH` on the Ollama server. A small model may also answer in the wrong shape more often; Scrylux checks every answer, and asks again up to three times.

### vLLM (local)

```sh
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=http://vllm:8000/v1
LLM_MODEL=<the served model name>
LLM_LOCAL=true
LLM_API_KEY=<only if you started vLLM with --api-key>
```

### Amazon Bedrock

```sh
LLM_PROVIDER=bedrock
LLM_REGION=us-east-1
LLM_MODEL=<a model id or inference profile id enabled in that region>

EMBEDDING_PROVIDER=bedrock
EMBEDDING_REGION=us-east-1
EMBEDDING_MODEL=amazon.titan-embed-text-v2:0
```

Bedrock needs no key of Scrylux's own. It uses the AWS credentials of the host: an instance or task role, which is what to use on AWS, or the usual `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` variables. The compose files do not pass `AWS_*` variables to the container; add them in a `docker-compose.override.yml` if you need them.

Give the role the least it needs: `bedrock:InvokeModel` on the ARNs of the models you chose, and nothing else. For an inference profile, allow the profile and the foundation models it routes to.

Amazon Titan Text Embeddings V2 is the only embedding model Bedrock supports here. A model not enabled in your region fails when it is used, and the [check](#checking-the-configuration) reports it.

### Google Gemini

```sh
LLM_PROVIDER=gemini
LLM_MODEL=gemini-3.6-flash
LLM_API_KEY=<a Gemini API key>

EMBEDDING_PROVIDER=gemini
EMBEDDING_MODEL=gemini-embedding-2
```

This is the Gemini Developer API with an API key. Gemini through Google Cloud's Vertex AI is not supported.

> **Data use.** On the Gemini API's **unpaid tier**, Google says it may use what you submit, and the answers, to improve its products, and that human reviewers may read them. Google asks you not to submit sensitive, confidential or personal information to it. On **paid** use it says it does not use your prompts or answers for that. Which one applies depends on how your key's project is billed, and the terms differ for the EEA, the UK and Switzerland. Read [Google's terms](https://ai.google.dev/gemini-api/terms) before you send anything you would not publish.

## Keeping a key out of files you might commit

Export it in your shell, or put it in a `.env` file, which is git-ignored. Do not write it into `docker-compose.yml`. On AWS, store it in the Secrets Manager secret that `DB_SECRET_ID` names, under the key `LLM_API_KEY` (and `EMBEDDING_API_KEY`); a value there overrides the environment's.

Scrylux never logs a key, stores it in the database, or sends it to the browser.

## Prices

Each request reports its tokens and what it cost. Scrylux ships a list of prices for well-known hosted models (`packages/llm/data/prices.yaml`), and each entry says when it was checked and where the price is published. Providers change prices, so a price in the list can be out of date.

- **Your own prices win.** `LLM_PRICE_INPUT` and `LLM_PRICE_OUTPUT` (US dollars per million tokens) override the list for your generation model, and `EMBEDDING_PRICE_INPUT` does for your embedding model. Use them for an Azure deployment, a new model, a negotiated price, or a stale entry.
- **Unknown is not free.** A model that is in neither place has an unknown cost, and Scrylux says so instead of reporting zero. A local model counts as free only if you set its price to `0`.
- **Tokens the provider does not report** are estimated from the text and marked as estimated.

## Limits

- **Time.** One request to a provider may take at most `LLM_TIMEOUT` (default five minutes). A request that fails because the provider is overloaded or does not answer is tried again at most twice more, after one and two seconds; a provider that asks for a longer wait than a minute is not waited for.
- **Output.** A request asks for at most 16,000 tokens of answer unless the feature asks for more, and never more than 32,000. An answer cut off at the limit is not asked for again.
- **Asking again.** An answer that does not match the required shape is asked for again, up to three times in all.
- **Embeddings.** One request holds at most 1,000 texts, which Scrylux splits into the batches each provider accepts.

## Variables Scrylux refuses

The libraries that talk to each provider read environment variables on their own: a key, an address, extra request headers, logging, telemetry. If one of them were left in the environment (say `OPENAI_API_KEY`, from another tool you once ran), a library could send a key that Scrylux never checked, send the configured key to an address Scrylux never validated, or print a prompt. So while a provider is configured, **Scrylux refuses to start if any of these is set**, and the message names the variable:

- every variable that begins with `ANTHROPIC_`, `OPENAI_` or `AZURE_OPENAI_`;
- `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GEMINI_BASE_URL`, `GOOGLE_VERTEX_BASE_URL`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_ENTERPRISE`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and `GOOGLE_SDK_NODE_LOGGING`;
- `AWS_BEDROCK_BASE_URL`;
- while Bedrock is configured, `AWS_ENDPOINT_URL`, every `AWS_ENDPOINT_URL_*` and `AWS_IGNORE_CONFIGURED_ENDPOINT_URLS`, which send the AWS client to another address.

Remove the variable, or use Scrylux's own setting for it ([Install and run](install.md#environment-variables)). With no provider configured, none of this applies.

**AWS's own credential variables are allowed**, because Bedrock is meant to use them: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_PROFILE`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_ROLE_ARN`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `AWS_BEARER_TOKEN_BEDROCK`, the container and instance-metadata variables, the config and credentials file locations, and a few others that only tune AWS's client (FIPS and dual-stack endpoints, retry settings that Scrylux overrides). The full list is `AWS_EXEMPT_VARIABLES` in `packages/llm/src/config.ts`.

A test reads the installed provider libraries and fails when one starts reading a variable that is on neither list, so an update of a library cannot add one unnoticed.

## Checking the configuration

After you set a provider, check that it works. The check sends one tiny fixed request, with none of your data, to the generation provider and, if you set one, to the embedding provider. It is the only thing in this release that makes a live request.

```sh
docker compose exec app node dist/llm-check.js     # in the published container
pnpm --filter @scrylux/api llm:check                # from a source checkout
```

It reads the same environment and secrets-manager secret as Scrylux, never the database. Example:

```text
Generation: anthropic, model claude-sonnet-5-5, hosted (data sent to it leaves this install)
  OK in 1.8 s, 1 attempt, 64 input + 9 output tokens, cost $0.000218 (price list)

Embeddings: openai-compatible, model nomic-embed-text, local (declared with EMBEDDING_LOCAL=true)
  OK in 0.2 s, dimension 768, 9 input tokens (estimated), cost unknown (no price set)
```

When an operation fails, the report names the failure and says which setting to look at:

```text
Generation: openai-compatible, model llama3.3, hosted (data sent to it leaves this install)
  FAILED: not available. The provider does not know this model, or it is not enabled for this account.
  Check LLM_MODEL. For Ollama, run `ollama pull <model>` first.
  Used: 1 attempt, 0 input + 0 output tokens, cost unknown (no price set)
```

A failed operation still says what it used, because a request can fail after it has spent tokens (an answer in the wrong shape, asked for three times). The line is left out when nothing was sent.

The report never shows a key, an address, the provider's own error text or the model's answer. Scrylux's one log line for each request goes to the error output (`stderr`), so the report on `stdout` can be read or piped on its own.

| Exit status | Meaning |
| --- | --- |
| `0` | Every configured operation worked, or none is configured |
| `1` | At least one configured operation failed |
| `2` | A setting is invalid, and the message says which |

A check against a provider that never answers waits for `LLM_TIMEOUT` three times, which is about fifteen minutes at the default. For a quicker answer, shorten it for that run: `docker compose exec -e LLM_TIMEOUT=30s app node dist/llm-check.js`.

The check asks for the same output limit as any other request (16,000 tokens), because a model that reasons counts its reasoning against it. On a hosted reasoning model that can cost a few cents.
