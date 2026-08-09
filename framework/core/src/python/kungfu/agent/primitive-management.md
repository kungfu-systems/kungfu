---
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: 2026-07-24
theme: primitive-management
doc_type: agent-guide
sources: [local-files, user-consensus]
confidence: high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-25
ai_provenance: Codex on 2026-07-25; derived from the checked-in three-plane Primitive contracts, Xinfa route, Shifu authoring command, and CLI contracts; no private material used
---

# Primitive Management for Agents

The incubation passport registry is the sole Primitive intake. The Primitive
Catalog v2 is a derived, Root-bearing projection; neither this document nor
the installed CLI can create, promote, reclassify, or declare runtime
availability for a Primitive.

Keep the three planes separate:

- Definition records durable semantics, hierarchy, lifecycle, invariants, and
  rooted typed relations.
- Admission derives a seven-axis evidence vector and a policy conclusion.
  Changing a label cannot create proof.
- Availability binds an explicit runtime observation to a Catalog Root,
  workspace, platform, Profile Roots, authority/capability/storage boundary,
  Cut, health, reason codes, and evidence Roots.

In a source checkout, do not guess a documentation route. The authoring
entrypoint compiles the exact `kungfu-primitive-management-agent` Xinfa Task
Chart before returning a plan. For an Agent-managed write, return the current
dry-run's projection Root:

```sh
PLAN="$(./shifu primitive:new -- --id example --name Example --layer example \
  --family ordinary-capability --kind example-responsibility \
  --boundary-participation responsibility \
  --deletion-rationale 'Deletion removes the durable example responsibility.' \
  --substitution-rationale 'No existing Primitive can substitute for it.' \
  --compression-rationale 'Compression would fuse independent responsibilities.' \
  --actor agent)"
CONTEXT_ROOT="$(printf '%s\n' "$PLAN" | jq -r '.context.projectionRoot')"
printf '%s\n' "$PLAN"
./shifu primitive:new -- --id example --name Example --layer example \
  --family ordinary-capability --kind example-responsibility \
  --boundary-participation responsibility \
  --deletion-rationale 'Deletion removes the durable example responsibility.' \
  --substitution-rationale 'No existing Primitive can substitute for it.' \
  --compression-rationale 'Compression would fuse independent responsibilities.' \
  --actor agent --context-root "$CONTEXT_ROOT" --write
./shifu check:primitive-catalog
```

The write recompiles the Task Chart. Missing, degraded, omission-bearing,
task-mismatched, or stale context fails before the passport or scaffold is
written. The receipt binds the actor, Primitive id, route, content Roots,
catalog Root before and after, and affected paths. A human source contributor
uses the explicit `--actor human --write` path; it still compiles and records
the current context, but does not require a previously returned Root.

This source workflow may compile the small Xinfa documentation component. It
does not require a full Kungfu product build. Native and packaged-product
qualification remain later gates.

From an installed product, query the same shipped catalog read-only:

```sh
kungfu primitive list --json
kungfu primitive show fact --json
kungfu primitive explain fact --json
kungfu primitive graph --from assignment --json
kungfu primitive availability fact --json
kungfu primitive availability fact --observation observation.json --json
```

These commands read the existing `primitive-catalog` contract. The
no-observation availability command returns `unknown`. They do not add a
second catalog, mutate a passport, turn missing evidence into proof, or infer
availability from source or artifact presence.

External adoption and improved long-running Agent effectiveness remain
unproved. Establishing either requires separately authorized longitudinal
evidence.
