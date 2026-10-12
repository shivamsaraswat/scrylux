# Contract: what a release is made of

The files and published things this milestone adds or changes, with the form each must take. The
pipeline that publishes them is in [release-pipeline.md](./release-pipeline.md); the checks that hold
them are in [checks.md](./checks.md).

## The version

One version per release, written as `MAJOR.MINOR.PATCH`. For v0.1 it is **0.1.0**, which all five
workspace packages already carry. Where it appears:

| Place | Form | Checked by |
|---|---|---|
| Git tag | `v0.1.0`; a candidate is `v0.1.0-rc.1` | gate G1 |
| The five `package.json` files (`apps/api`, `apps/web`, `packages/*`) | `"version": "0.1.0"`, identical | check V, gate G3 |
| `CHANGELOG.md` | heading `## [0.1.0] - 2026-10-DD` | check V, gate G4 |
| `docker-compose.release.yml` | `${SPECTER_VERSION:-0.1.0}` | check V, gate G3 |
| Image tag | `0.1.0` (a candidate: `0.1.0-rc.1`); `latest` for a final release that is the highest | pipeline |
| Image label | `org.opencontainers.image.version` = the tag without `v` | `verify-public` |
| Release title | `v0.1.0` | pipeline |

A candidate (`-rc.N`) is a candidate **for** the version in the packages and the changelog: those
carry the core `0.1.0` while `0.1.0-rc.1` is rehearsed, and nothing is bumped for a candidate. The
app shows no version and `/health` is unchanged (FR-040).

## The image

| Property | Value |
|---|---|
| Name | `ghcr.io/shivamsaraswat/specter` |
| Tags | the exact version; `latest` only for a final release that is not lower than any other final release. No floating `0.1` tag |
| Platforms | `linux/amd64` and `linux/arm64`, one tag, one index |
| Built from | the repository's `Dockerfile`, in the pipeline, from the tagged commit |
| Runs as | the existing non-root `node` user; nothing in the image changes except what is below |
| Labels (image config) and annotations (index) | `org.opencontainers.image.source` = `https://github.com/shivamsaraswat/specter`; `.version`; `.revision` = the commit; `.licenses` = `Apache-2.0`; `.title` = `Specter`; `.description` |
| Not in v0.1 | signature, build attestation, SBOM (Clarifications, 2026-10-12; `plan.md`, Phase 6) |

### Dockerfile change

The builder stage becomes `FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:…`: it compiles
TypeScript and installs the production dependencies once, on the machine that builds, for both
platforms. The final stage is unchanged and has no `RUN`, so nothing is emulated. The production
dependencies are pure JavaScript (verified, research #3), so one `node_modules` is right for both. The
`FROM node:` regular expression of `.github/actions/setup-workspace` is widened to accept the flag.
The contributor's `docker build .` and `docker compose up --build` are unchanged in effect (FR-041).

## The release compose file

`docker-compose.release.yml` at the repository root; attached to each release as `docker-compose.yml`
so that `docker compose up` finds it. It is **not** `docker-compose.yml`, which keeps its contributor
defaults (a published database port).

```yaml
services:
  db:
    image: postgres:16-alpine@sha256:<the digest CI uses>
    environment:
      POSTGRES_DB: threats
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: ${DB_PASSWORD:-devpassword}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres -d threats"], interval: 3s, timeout: 3s, retries: 10 }
    # no ports: the database is reachable from the app only
  app:
    image: ghcr.io/shivamsaraswat/specter:${SPECTER_VERSION:-0.1.0}
    ports: ["127.0.0.1:${PORT:-3000}:3000"]
    environment: # as docker-compose.yml: PORT, DB_*, JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD, with the same defaults
    depends_on: { db: { condition: service_healthy } }
volumes:
  pgdata:
```

- **Only the app is published, and only on the loopback address** (FR-017, US2 scenario 3). Reaching
  it from another machine is a deliberate edit, which the quickstart says belongs behind a proxy that
  terminates TLS.
- The defaults (`admin`/`admin`, a development signing secret, `devpassword`) are the existing
  compose defaults, for local use. The product does not refuse them (FR-040); the quickstart names each
  value to set.
- `SPECTER_VERSION` chooses a version (FR-018). The file's default is the version of the release it
  is attached to, so the asset of v0.1.0 starts 0.1.0. For a **candidate** the attached copy has its
  default replaced by the full version (`0.1.0-rc.1`), by the pipeline's `notes` job, because only that
  image exists; the committed file keeps the core version that gate G3 and check V compare.

## The release page

Built by `scripts/release/notes.ts`; everything is text, so it is unit-tested.

```text
<the changelog entry for the core version, headings kept, "## [0.1.0] - date" line removed>

## Run it

docker compose up   # with the attached docker-compose.yml; see the README quickstart
Image: ghcr.io/shivamsaraswat/specter:0.1.0
Digest: sha256:<index digest>   (pin it with ghcr.io/shivamsaraswat/specter@sha256:<digest>)

The image is not signed and carries no build attestation or SBOM in this release; pin it by digest
(verifiable release images are planned for Phase 6). Open risks are recorded in Specter's own threat
model: docs/threat-model/. To report a vulnerability, see SECURITY.md; do not open a public issue.

Attached: docker-compose.yml (the quickstart's file), notes-app.specter.json (the demo; fictional).
```

A pre-release adds "This is a release candidate." at the top. The page never says the version is
"secure" (FR-034).

## CHANGELOG.md

[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) layout, newest first, one entry per version:

```text
# Changelog
<one sentence: what this file is; the versioning rule: MAJOR.MINOR.PATCH, v0.x may change;
 a second sentence: open risks are recorded in docs/threat-model/, and a vulnerability is reported
 privately as SECURITY.md says, never in a public issue (FR-034)>

## [0.1.0] - 2026-10-DD
### What you can do          ← grouped by what a user does: draw, generate, work through, report, exchange
### What it does not do yet  ← the limitations of README "Limits": no roles; no AI; single container; no TLS; open risks
### Upgrading                ← back up first; migrations only move forward; the Phase 1 data drop; supported path
```

An entry for a later version adds the same three headings only where they have something to say. It
holds no commit list. Every capability claimed is one FR-022 can demonstrate. The `[0.1.0]: <compare
or release URL>` link definition sits at the bottom.

## README.md

New or changed sections (existing ones keep their text; the contributor path of FR-041 stays under
"Development"):

| Section | Content |
|---|---|
| Status (replaces "Current status: Phase 2 in progress…") | v0.1 is the first release; Phases 0 to 2 are built, 3 onward planned; link to the changelog and the releases |
| Quickstart (first runnable section) | Download the release's `docker-compose.yml`; `docker compose up -d`; open `http://localhost:3000`; sign in with the compose defaults; the **before you expose it** box (FR-017); choosing a version; stopping and wiping |
| Try the demo | Download `notes-app.specter.json` from the release; **Import threat model** on a project; what to look at |
| Screenshots | Four images of the demo with alt text (below), and how to retake them (FR-033) |
| Limits | The list of FR-019: no roles, no AI, one container, no TLS, link to the threat model's open risks |
| Upgrading | Back up (`pg_dump`), choose the next version, migrations run forward at start |
| Roadmap table | Phase 2 marked ✅ in the form of Phases 0 and 1 |
| Run locally with Docker | Renamed "Run from source" and kept as the contributor path |

Links to the changelog, releases, demo, threat model, contribution guide and `SECURITY.md` are all
present. The sentence "Specter has no release yet" is nowhere.

## SECURITY.md, plan.md, PR template

- `SECURITY.md`, *Supported versions*: the latest release line (v0.1.x) receives security fixes;
  nothing older; `main` is not a supported version. The sentence "Specter has no release yet (v0.1 is
  planned for Phase 2)" is removed.
- `plan.md`: Phase 2 heading marked ✅ and "(done)" as Phases 0 and 1 are; the open decision "Name" moves to
  **Decided** with the outcome of the name check (FR-032); the Phase 6 item of Clarifications 2026-10-12
  is already there.
- `.github/pull_request_template.md`: no change; its Threat Model prompt already asks about the
  committed model.

## docs/releasing.md (FR-029, FR-035)

Sections, in order: *Before the first release only* (the name check, record below); *Readiness* (the
list of gates a person confirms: name check recorded, README claims reviewed against the app,
clean-machine walkthrough recorded, required checks green on the commit, `CHANGELOG.md` entry dated,
versions agree, the threat model updated); *One-time repository settings* (the tag rulesets and the
package visibility, each with its recreate/verify command); *Rehearse with a candidate* (tag
`v0.1.0-rc.1`, what to check); *Release* (tag the commit, **push that one tag by name**, never
`--tags`; what the run does; what to verify afterwards: the release page, the anonymous pull on both
platforms, the two attachments); *If it fails* (a refusal message per gate and what to do; a re-run
completes the rest); *A bad release* (never replace an image; edit the notes to say so and point to
the fix; publish the next patch; use a security advisory where it applies); *The name check
record* (what was searched, when, what was found, who decided).

## The demo

`docs/demo/` (not `docs/threat-model/`, which a check holds to its three files):

| File | Content |
|---|---|
| `notes-app.specter.json` | The Specter file of the demo model, exactly as Specter exports it (FR-025) |
| `README.md` | What it is (fictional, an example, not guidance), how to load it, what to look at, how it was produced and how to update it (the same procedure as the threat model's) |

Its project is named `Specter demo (fictional)` and its model `Notes app (fictional demo)`, so the
fiction is on the screen where it is loaded. The blueprint is in [data-model.md](../data-model.md#2-the-demo-model).

## Screenshots

`docs/images/`, four PNG files, each at most 600 KB and 3 MB in all, taken by hand from the loaded
demo with a 1400 × 900 window, cropped to the application area, no browser chrome, no account name
or address on screen:

| File | Shows |
|---|---|
| `diagram-editor.png` | The diagram with its trust boundary and the open-threat counts on the elements |
| `threats-for-element.png` | One selected element and the threat list filtered to it, with statuses and risk |
| `report.png` | The report's risk summary and one element's threats, in the browser |
| `import-export.png` | The import preview ("Everything in this file will be imported") or the export buttons |

The README embeds each as `![<what it shows, in a sentence>](docs/images/<file>)`.
