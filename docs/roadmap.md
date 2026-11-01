# Roadmap

Built one phase at a time; each phase ends with something usable.

| Phase | Goal | Release |
| --- | --- | --- |
| 0 ✅ | CRUD tracker for STRIDE threats, deployed to AWS | — |
| 1 ✅ | Re-platform to a TypeScript monorepo (React, Express, Postgres) with a real domain model: projects, threat models, diagram elements, threats, mitigations. Phase 0's learning data is dropped, not migrated | — |
| 2 ✅ | Manual threat modeling: data-flow-diagram editor with trust boundaries, rule-based STRIDE-per-element threat generation, threat lifecycle and risk scoring, reports, OTM and Threat Dragon import/export | v0.1 |
| 3 | AI threat models from uploaded docs or pasted text, with citations and human review. Bring your own LLM: Anthropic, OpenAI, Bedrock/Azure, Gemini, or local models via Ollama/vLLM | v0.2 |
| 4 | Threat models from code repositories and IaC (Terraform, Kubernetes, compose), with drift detection as the code changes | v0.3 |
| 5 | Integrations: Jira/Confluence context, threats pushed as tickets, automatic design reviews on PRs and tickets, MCP server, CLI | v0.4 |
| 6 | Enterprise readiness: RBAC, SSO (OIDC/SAML), audit log, versioning and approvals, Helm chart | v1.0 |
| 7 | More methodologies and frameworks: LINDDUN, MAESTRO (agentic AI), attack trees, ATT&CK/CAPEC/CWE mapping, compliance mapping | v1.x |

Phase 3 is built a milestone at a time. So far on the main branch: the provider layer and the worker that runs jobs, and, as the third milestone, **documents**: a threat model can hold `.md`, `.txt`, `.pdf` and `.docx` files and pasted text, which Scrylux reads, cuts into chunks and gives embeddings (nothing is drafted from them yet; that is the next milestone, and v0.2 is not yet released). See [Documents and storage](install.md#documents-and-storage).

Back to the [README](../README.md).
