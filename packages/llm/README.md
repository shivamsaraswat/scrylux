# @scrylux/llm

The one way Scrylux asks a language model for something. Two operations, the same for every provider:

- **A structured result.** You give a zod schema, instructions and, if you have any, the text to work on. You get back an
  object that was checked against the schema, or a failure that says why. Unvalidated model output never leaves this package.
- **Embeddings.** You give a list of texts and get one vector per text, in order.

Behind them sit four adapters: Anthropic, OpenAI-compatible (OpenAI, Azure OpenAI, Ollama, vLLM, through a base address), Amazon
Bedrock and Google Gemini. Every request returns a usage record (tokens, cost or "unknown", time, attempts, outcome) and writes one
log line with those facts and nothing else.

Nothing in Scrylux sends user content through it yet. The operator's check command is the only live caller; the worker, ingestion
and the prompts come in later Phase 3 milestones. Design notes, decisions and contracts:
[`specs/phase-3/milestone-1-llm-provider-layer/`](../../specs/phase-3/milestone-1-llm-provider-layer/). For operators:
[`docs/ai-providers.md`](../../docs/ai-providers.md).

## Using it

```ts
import { createLlm, parseLlmConfig } from '@scrylux/llm';
import { z } from 'zod';

const llm = createLlm(parseLlmConfig(process.env));

const result = await llm.generate({
  schema: z.strictObject({ components: z.array(z.strictObject({ name: z.string() })) }), // every object strict
  schemaName: 'components',
  instructions: 'List the components of the system described below.',
  content: documentText, // untrusted: it goes only inside a marked section, never where instructions go
});
if (result.ok) use(result.value);
else report(result.failure.category); // one of a fixed set; the message is fixed text
```

The full contract is [`library-api.md`](../../specs/phase-3/milestone-1-llm-provider-layer/contracts/library-api.md). In short:

- `generate` and `embed` never reject for a provider or network problem: they resolve to `{ ok: false, failure, usage }`. They throw
  only for a programming error (a schema that is not strict, an argument out of range), before anything is sent.
- There is no way to pass tools, to stream, or to set the temperature. A model that accepts a temperature gets 0; one that does
  not gets none, and the usage record says which.

## What the files are

| Path | What it holds |
| --- | --- |
| `src/` | The code: configuration (`config.ts`), the client (`client.ts`), the attempt loops (`attempts.ts`, `embed.ts`), schema conversion (`schema.ts`), the content section (`content.ts`), usage and cost (`usage.ts`, `pricing.ts`), the log line (`log.ts`) and `adapters/` |
| `data/prices.yaml` | A dated, sourced price for each listed model |
| `data/models.yaml` | What each model accepts: a temperature, a native output format, the name of its output limit, an embedding batch size |
| `prompts/` | Every fixed piece of text the layer adds to a prompt, and the check command's request |
| `testing/` | Stub servers and a client that talks to them, for tests only. Exported as `@scrylux/llm/testing`, never built or shipped |
| `test/` | The tests. None needs a provider, a key or the network |

## Adding a model's price

Edit `data/prices.yaml`. Copy the price from the provider's page, set `checked` to the day you did, and keep `source`. A model is
matched by its exact id, so nothing is ever priced by a guess. Never estimate a price: leave the model out, and its cost is unknown.
The test reads every entry and checks its shape.

## Adding a model's capabilities

Edit `data/models.yaml`. The first entry whose `match` fits the model id wins, and a field it leaves out comes from the provider's
`*` entry at the end. A model that refuses a temperature (`temperature: omit`) needs a `reason` and an https `source`, so a reviewer
can check the advice. A model this file does not know is not a problem: if a provider answers 400 naming a setting, the layer sends
the request again without it, and remembers for the life of the process.

## Adding a provider

Write `src/adapters/<name>.ts` with the `Adapter` interface of `adapters/types.ts` and its stub server in `testing/stubs/`, then wire
it into `client.ts`, `config.ts` and the data files. The rules every adapter follows:

- **Load the SDK inside the factory**, with a dynamic `import()`, so a provider that is not configured costs nothing.
- **Turn the SDK's own retries off.** The attempt loop retries, once, for every provider. Where the SDK uses `fetch`, give it the
  fetch of `adapters/http.ts`, or a time limit above five minutes does nothing.
- **Set every client option that has an environment default**, with a value from Scrylux's own configuration. The names come from
  the installed package's type definitions.
- **Map every error to a category** (`FAILURE_MESSAGES` in `errors.ts`) and throw an `AdapterError`. Never put the provider's error,
  a key or an address in anything you throw.

## Why a stray variable stops Scrylux from starting

The SDKs read environment variables on their own: a key, an address, extra headers, logging. `parseLlmConfig` refuses them while a
provider is configured (rule 11 of the configuration contract). `test/sdk-env.test.ts` reads every installed SDK and its
dependencies, finds each vendor variable they mention, and fails when one is neither refused, nor an AWS credential variable that
Bedrock is meant to use, nor shown not to be read. When an update of an SDK makes it fail, decide each name it prints, in
`src/config.ts` or in the test's `NOT_READ`, with the reason.

## Commands

```sh
pnpm --filter @scrylux/llm test
pnpm --filter @scrylux/llm typecheck
pnpm --filter @scrylux/llm lint
```
