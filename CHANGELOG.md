# Changelog

What changed in each release of Scrylux, newest first. Versions are `MAJOR.MINOR.PATCH`; while the major version is 0, a minor release may change things that matter to you, and each entry says so under *Upgrading*. Open risks are recorded in [Scrylux's own threat model](docs/threat-model/), and a vulnerability is reported privately as [SECURITY.md](SECURITY.md) says, never in a public issue.

## [0.1.0] - 2026-10-18

The first release: a manual threat modeling tool you run yourself. Draw a system, get STRIDE threats from rules, work them to a decision, and take the result with you.

### What you can do

- **Draw** the system as a data-flow diagram, in the browser. The five element types are external entities, processes, data stores, data flows, and trust boundaries, which hold what is inside them and can nest. Each element can carry technology tags and security flags (for example: authenticated, encrypted in transit, stores sensitive data, internet-facing). The diagram saves as you go, with undo and redo.
- **Generate** STRIDE threats from the diagram. A library of rules, kept as plain files, proposes threats per element type and per flag, with suggested mitigations. Running it again changes nothing that is already there, keeps your edits, and marks a generated threat **stale**, instead of deleting it, when the diagram or a rule changed under it.
- **Work through** the threats. Each has a status (open, mitigated, accepted, not applicable), a likelihood and an impact that give its risk, and mitigations with their own status (proposed, implemented, verified). Accepting a risk or dismissing a threat takes a reason; marking one mitigated takes an implemented or verified mitigation. Selecting an element on the diagram filters the threat list to it, and every element shows how many open threats it has.
- **Report** on a threat model as a Markdown document or as a print-friendly page (use the browser's *Save as PDF*): the diagram, the threats grouped by element, and a risk summary.
- **Exchange** a threat model. Export it as a **Scrylux file** (lossless: a re-import gives back the same diagram, threats and mitigations) or as an **OTM** file; import a Scrylux file, an OTM file or an OWASP **Threat Dragon** v2 file. Every import shows what it will do first, and lists anything it cannot carry over.
- **Keep it in one place.** Accounts, projects and threat models, a documented REST API with an OpenAPI document, and sign-out from every device. The whole thing is one container and a PostgreSQL database.
- **Try it on a finished example.** A fictional demo threat model, [`docs/demo/`](docs/demo/), is attached to this release.

### What it does not do yet

- **No roles.** Every account can read, change and delete everything. Roles and single sign-on are planned for Phase 6.
- **No AI.** Nothing in v0.1 reads documents or calls a language model. Drafting a threat model from documents, with citations and a human accept step, is planned for Phase 3.
- **One container with its database, and no TLS of its own.** Put a proxy that terminates TLS in front of it before anyone else can reach it. The quickstart's sign-in and signing secret are defaults for trying it on your own machine.
- **The image is not signed.** It carries no build attestation or SBOM in this release; pin it by the digest on the release page. Verifiable release images are planned for Phase 6.
- **Open risks exist** and are listed, with what covers them, in [Scrylux's own threat model](docs/threat-model/).

### Upgrading

- **Back up first.** `docker compose exec db pg_dump -U postgres threats > backup.sql`. Migrations only move forward, and run when the app starts; there is no downgrade.
- **The supported path is from one release to the next.** There is no support for upgrading from an arbitrary commit of `main`.
- **Coming from the original tracker (Phase 0)?** Phase 1 removed it, and a migration drops its entries, the table that held them and the `/api/threats` endpoints. **Nothing is exported first**: those entries were throwaway data. User accounts, and any project that did not come from that import, are untouched.

[0.1.0]: https://github.com/shivamsaraswat/scrylux/releases/tag/v0.1.0
