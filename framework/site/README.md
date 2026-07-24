---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
period: ongoing
theme: kungfu-site-bundle
doc_type: repository-document
sources: [local-files, user-consensus]
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-07-24
---

# `@kungfu-tech/site`

This package publishes the auditable product-positioning bundle consumed by
Kungfu human and agent sites. It answers one navigation question:

> How do Kungfu's product promise, `.kungfu` workspace and format boundary,
> primitives, runtime, ABI, SDKs, extensions, products, qualification,
> decisions, and future horizons fit together?

It does not own those technical facts. `src/site-bundle.source.json` is a
composition declaration. The generator resolves every declared authority in
the current monorepo, records its SHA-256 content root, and emits deterministic
artifacts under `dist/site/`.

## Published contract

- `dist/site/site-bundle.json` — complete human and agent product map.
- `dist/site/agent-index.json` — compact machine reading order.
- `dist/site/adr-map.json` — exact generated ADR navigation projection.
- `schema/site-bundle.schema.json` — package/consumer contract.

The bundle schema version, npm pickup version, `.kungfu` layout/spec versions,
ABI versions, and component contract versions are independent axes.

## Authority boundary

The package may frame, order, summarize, and link. It must not:

- promote the historical Spec 0.1 draft into a normative format;
- turn qualified-shadow primitives, staged KFX/Profile behavior, or
  source-built SDKs into stable release claims;
- redefine Fact, Episode, Action Geometry, ABI, Profile, or release semantics;
- treat inferred ADR navigation as architecture authority; or
- omit known limits from the human or agent projection.

Run through Shifu from the repository root:

```sh
./shifu --filter @kungfu-tech/site build
./shifu --filter @kungfu-tech/site verify
./shifu --filter @kungfu-tech/site test
```
