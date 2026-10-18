# Exchange fixtures

Files from other projects, used only as test data for the import and export suites
(`apps/api/test/exchange/`). They are not shipped in the image and are not part of Scrylux's source.
They were fetched on 2026-10-10 and are unchanged.

## Open Threat Model (OTM)

Source: <https://github.com/iriusrisk/OpenThreatModel>, tag `0.2.0` (commit
`03680ff9d7b42d90a978d97e36d2d46f94204685`).

Licence: **CC-BY-SA-4.0** (<https://creativecommons.org/licenses/by-sa/4.0/>). The files are copied
unchanged, with attribution to IriusRisk and the OpenThreatModel contributors. The licence applies to
these files only; the rest of the repository stays Apache-2.0.

| File | Upstream path | Last commit touching it |
|---|---|---|
| `otm/otm_schema.json` | `otm_schema.json` | `06288a0d4d9d242a7bc80e138ed7417fccd60a5d` |
| `otm/EXAMPLE.json` | `EXAMPLE.json` | `92d7ec6e1c43af8dc4500fb182ea0bb04863be8a` |

Used to check that Scrylux's OTM export is valid (SC-002) and that an OTM file from another tool
imports (SC-003).

## Threat Dragon

Source: <https://github.com/OWASP/threat-dragon>, folder `td.vue/src/service/demo/`.

Licence: **Apache-2.0**, the same as this repository.

| File | Last commit touching it | Notes |
|---|---|---|
| `threat-dragon/v2-threat-model.json` | `24b89f45e33dccd43337c23bcef51e1a456a9fba` | STRIDE; three boundary lines |
| `threat-dragon/generic-cms.json` | `24b89f45e33dccd43337c23bcef51e1a456a9fba` | STRIDE; one boundary box |
| `threat-dragon/iot-device.json` | `24b89f45e33dccd43337c23bcef51e1a456a9fba` | STRIDE; one boundary line |
| `threat-dragon/online-game.json` | `24b89f45e33dccd43337c23bcef51e1a456a9fba` | STRIDE; three boundary boxes |
| `threat-dragon/payment-online.json` | `24b89f45e33dccd43337c23bcef51e1a456a9fba` | STRIDE; three boundary boxes |
| `threat-dragon/three-tier-web-app.json` | `5eb83f6d6eab98fc5a8711d62a53caed651f81c9` | STRIDE; two boundary boxes |
| `threat-dragon/cryptocurrency-wallet.json` | `5eb83f6d6eab98fc5a8711d62a53caed651f81c9` | **CIA** diagram: its threats are noted, not imported |
| `threat-dragon/renting-car.json` | `24b89f45e33dccd43337c23bcef51e1a456a9fba` | **LINDDUN** diagram: its threats are noted, not imported |
| `otm/mobile-cloud.otm.json` | `683b12db4f1eb7063001b5a75655dee9bc8bb20a` | OTM **0.1.0**: a refusal fixture, since Scrylux reads 0.2.0 only |

All eight `threat-dragon/` files are Threat Dragon version `2.3.0`. The demo folder's
`huskyai.tmbom.json` is neither Threat Dragon v2 nor OTM and is not used.
