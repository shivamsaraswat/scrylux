# Contract: configuration

Two variables, both documented in the environment-variable table of `docs/install.md` with the process that reads
them (FR-081). Each is checked when its process starts: a value that is not a whole number in range stops the process
with a message that names the variable and never its value (FR-010).

| Variable | Read by | Default | Range | What it does |
|---|---|---|---|---|
| `EXTRACTION_CONTEXT_CHARS` | API and worker | `36000` | 2,000–2,000,000 | The most chunk text one extraction sends. At or under it, all ready chunks are sent; over it, chunks are chosen (research #5, #6). The API uses it to decide the path at start and to refuse a retry of `input_too_large`; the worker uses it to choose. |
| `EXTRACTION_MAX_OUTPUT_TOKENS` | API and worker | `12000` | 1,000–32,000 | The output limit of the extraction request (research #9). The worker sends it. The API compares it with the value stored on a failed job to decide whether a retry of `output_limit_reached` may run (FR-045), so it needs the same value. |

Give both processes the same values of both, as for the provider settings (M3 edge case): when they differ, the worker's
values decide what is sent, and the API's what the page says and which retries it allows. Both processes parse both
variables when they start, so a bad value stops either one.

**Sizing note in `docs/install.md` and `docs/ai-providers.md`**: at the defaults one request needs a context of 32,768
tokens. Raising `EXTRACTION_CONTEXT_CHARS` by 4,000 characters needs about 1,000 more tokens of context, and raising
the budget past what the caps allow fails a start's job as `cap_reached` with `cap_below_one_request`.

No other setting changes. The job caps, runs and time limit of Milestone 2 apply as they are.
