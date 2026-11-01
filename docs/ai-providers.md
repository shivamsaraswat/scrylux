# AI providers

Scrylux can ask a language model for structured answers and for embeddings. You choose where the model runs, with environment values, and you can run without one. This page says how to set each provider up, what leaves your install, and what a request costs. The variables are listed in [Install and run](install.md#environment-variables).

Two things send a request. The [check](#checking-the-configuration) sends fixed text and none of your data. **Adding a document** (from v0.2) sends the document's text to your embedding provider, in chunks, to make its embeddings: [Documents](#documents) says what that means for where your data goes. No Scrylux feature sends your content to a generation provider yet; that starts with the AI features of a later milestone. Every request is made in the background, in a separate [worker](install.md#running-the-worker) process: the worker is the only process that talks to a provider, and the only one that holds its key.

## Running without AI

Set none of the variables below, and Scrylux behaves as it did before: it starts, answers `/health`, and never connects to a model provider. The log says `AI providers: generation off, embeddings off`.

If you set a provider, Scrylux checks every setting it needs when it starts, and refuses to start with a message that names the variable. It never contacts the provider at start, so a provider that is down, or a local model that starts later, does not stop Scrylux. Embeddings are optional: you can set a generation provider and no embedding provider.

## Hosted or local

Data sent to a **hosted** provider leaves your install. Data sent to a **local** one stays in it. Scrylux reports one of the two for each provider it uses, on the **Jobs** page and in every provider check's result.

- Anthropic, Amazon Bedrock and Gemini are always hosted.
- An `openai-compatible` provider is hosted unless you say it is local with `LLM_LOCAL=true` (or `EMBEDDING_LOCAL=true`). Scrylux cannot check that statement: a private address can be a proxy to a hosted service, so the address alone proves nothing. Declare it local only when you run the model yourself.
- A hosted provider must be reached over `https`. A plain `http://` address is accepted only for a provider declared local, so a key never crosses a network in the clear.
- An address may carry credentials (`https://user:pass@host/v1`), as one behind a proxy with basic authentication does. Scrylux sends them as HTTP Basic authentication when there is no API key, and never shows them. If you also set a key, the key is used and the credentials in the address are dropped.

## Setting up each provider

Put the values in a `.env` file next to the compose file (never commit it), or export them in your shell. [`.env.example`](../.env.example) lists them all. Compose passes every setting to both the `app` and the `worker` service, except the keys (`LLM_API_KEY`, `EMBEDDING_API_KEY`), which go to the `worker` alone. The app only reports which providers are configured and whether each is hosted or local, so it starts without a key; the worker needs it.

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

Scrylux never logs a key, stores it in the database, or sends it to the browser. Only the worker uses a key, but both processes read the secret that `DB_SECRET_ID` names (for the database credentials), so a key kept there reaches the app as well, though the app never uses it. To keep a key from the app, set it in the worker's environment instead ([Which process gets what](install.md#which-process-gets-what)).

## Prices

Each request reports its tokens and what it cost. Scrylux ships a list of prices for well-known hosted models (`packages/llm/data/prices.yaml`), and each entry says when it was checked and where the price is published. Providers change prices, so a price in the list can be out of date.

- **Your own prices win.** `LLM_PRICE_INPUT` and `LLM_PRICE_OUTPUT` (US dollars per million tokens) override the list for your generation model, and `EMBEDDING_PRICE_INPUT` does for your embedding model. Use them for an Azure deployment, a new model, a negotiated price, or a stale entry.
- **Unknown is not free.** A model that is in neither place has an unknown cost, and Scrylux says so instead of reporting zero. A local model counts as free only if you set its price to `0`.
- **Tokens the provider does not report** are estimated from the text and marked as estimated.

## Limits

- **Per job.** A background job is capped in tokens (`JOB_TOKEN_CAP`, 500,000 by default) and in dollars (`JOB_COST_CAP`, $5). Before each request the job works out the most that request could use, counting every attempt Scrylux may make for it, and does not send it if that would take the job past a cap, counting everything the job has used in all its runs. The job then ends as "cap reached". The dollar cap cannot be applied to a request whose model has no known price: the token cap still is, and the job says its cost is unknown. A provider check on a model with output priced above about $60 per million tokens needs a larger `JOB_COST_CAP`, because one check could use about 90,000 tokens at the largest. These caps bound one job, not your spend over time: set a spending limit on the provider account too.

- **Time.** One request to a provider may take at most `LLM_TIMEOUT` (default five minutes). A request that fails because the provider is overloaded or does not answer is tried again at most twice more, after one and two seconds; a provider that asks for a longer wait than a minute is not waited for.
- **Output.** A request asks for at most 16,000 tokens of answer unless the feature asks for more, and never more than 32,000. An answer cut off at the limit is not asked for again.
- **Asking again.** An answer that does not match the required shape is asked for again, up to three times in all.
- **Embeddings.** One request holds at most 1,000 texts, which Scrylux splits into the batches each provider accepts. A document's chunks are sent 64 at a time, and each request counts against the job's caps like any other.

## Documents

The documents of a threat model ([Documents and storage](install.md#documents-and-storage)) are read by the worker, cut into chunks and embedded. Four things follow for the model you choose:

- **Adding documents needs an embedding provider.** Without `EMBEDDING_PROVIDER`, the Sources tab says so, and the API refuses to add a document (409). Documents added earlier stay readable.
- **A chunk holds at most 2,000 characters.** Scrylux cuts the text at paragraph, line and sentence ends where it can, with no overlap between chunks. Your embedding model must accept at least **2,048 tokens** for one input, and every common embedding model does. A model that refuses a chunk fails the document as "input too large", and it cannot be retried until you choose another model, because the refusal would repeat.
- **Ollama's context must be 2,048 tokens or more.** Ollama's embedding models are often set to 2,048 by default, which is enough; a smaller `num_ctx` or `OLLAMA_CONTEXT_LENGTH` shortens inputs silently, and Scrylux cannot see that happen.
- **Dense scripts use more tokens.** A chunk of 2,000 characters of English is a few hundred tokens, but the same count of Chinese, Japanese or Korean text can be several times more. A large document in one of those scripts may reach `JOB_TOKEN_CAP` before it is done; the document then fails as "cap reached", writes nothing, and can be retried after an operator raises the cap.

**Where a document's text goes.** To the embedding provider, from the worker, as the chunks are embedded; to your database, as the text and the embeddings; and nowhere else. When the embedding provider is hosted, the text leaves your install, and the Sources tab says so before a document can be added, naming the provider, every time. When the generation provider is hosted, the same page adds that the AI features of later releases will send a document's text there too. With only local providers, the page says the text stays in your install. From the milestone that generates with documents (Milestone 4), the generation provider will receive chunks as well; the notice already says so.

When you change `EMBEDDING_MODEL`, existing documents keep their embeddings and the Sources tab marks them **out of date**; **Refresh embeddings** replaces them with the new model's, without changing a chunk. A document never holds the embeddings of two models.

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

After you set a provider, check that it works. The check sends one tiny fixed request, with none of your data, to the generation provider and, if you set one, to the embedding provider. It is the only thing that makes a live request, and there are two ways to run it.

**From the Jobs page.** Any signed-in person can choose **Check AI provider**. It runs as a background job, so a [worker](install.md#running-the-worker) must be running; the page says when none is. The job shows, for each operation, the provider, the model, whether its data leaves the install, whether it worked or why not and what to look at, and what it used. A check costs a few cents at most on a hosted model, so each account can start one every `PROVIDER_CHECK_COOLDOWN` (five minutes by default) and may have `JOBS_PER_ACCOUNT` jobs queued or running. Cancelling a check does not shorten the wait. The job can be cancelled while it runs.

**From a shell.** The same check, where Scrylux is deployed. Run it in the worker's container, because the worker is the one that holds the key:

```sh
docker compose exec worker node dist/llm-check.js  # in the published container
pnpm --filter @scrylux/api llm:check                # from a source checkout
```

It sends the same request as the job. It reads the same environment and secrets-manager secret as Scrylux, never the database. Example:

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

A check against a provider that never answers waits for `LLM_TIMEOUT` three times, which is about fifteen minutes at the default. For a quicker answer, shorten it for that run: `docker compose exec -e LLM_TIMEOUT=30s worker node dist/llm-check.js`.

The check asks for the same output limit as any other request (16,000 tokens), because a model that reasons counts its reasoning against it. On a hosted reasoning model that can cost a few cents. The Jobs page shows what each check cost.
