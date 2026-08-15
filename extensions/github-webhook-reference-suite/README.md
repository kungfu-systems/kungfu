---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
period: 2026-08
theme: kfx-webhook-agent-authoring
doc_type: guide
sources: [executable-probe, local-files, user-consensus]
confidence: high
sensitivity: public
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-10
ai_provenance: GPT-5 via Codex on 2026-08-10; based on installed-product and repository qualification evidence visible to this task; hidden model checkpoints and unobserved platform results are not claimed
---

# GitHub Webhook KFX reference suite

A maintained ordinary-public KFX example with three separable components:

- `github-webhook-ingress`: authenticated, bounded GitHub intake and normalized
  asynchronous observations;
- `github-event-view`: local inspection of receipt, normalization, no-op,
  rejection, and replay evidence without Dogfood;
- `github-dogfood-bridge`: optional exact-authority conversion of an
  observation into one immutable Dogfood Finding capture.

The ingress and view are required suite members. The bridge is optional and
fails dormant, so installing or removing Dogfood cannot break generic webhook
learning. GitHub events are observations only; no component admits Dogfood
Issues, creates or completes Work, mutates GitHub, or claims semantic
completion.

Both services were scaffolded from the installed version-matched authoring kit
and retain its exact SDK projection. See each component README for the public
Agent-first qualification commands and `docs/optional-real-github-canary.md`
for the one-shot real GitHub qualification.

## Start from the installed product

Give an Agent only the installed `kungfu` product and this goal:

> Create a local signed webhook KFX, prove invalid and replayed deliveries fail
> closed, retain rooted evidence, then remove it.

The public route is discoverable without this repository:

```sh
kungfu kfx author brief
kungfu kfx author capabilities --json
kungfu kfx author scaffold my-webhook --out ./my-webhook --execute --json
kungfu kfx author inspect ./my-webhook --json
kungfu kfx author validate ./my-webhook --json
kungfu kfx author build ./my-webhook --out ./build/my-webhook --execute --json
kungfu kfx author qualify ./build/my-webhook --json
kungfu kfx author package ./build/my-webhook --out ./my-webhook.tgz --execute --json
```

Planning is non-mutating until `--execute`. Installation, replacement,
rollback, and removal require explicit policy or owner-recovery authority. An
Agent must stop for that authority instead of inventing it. Qualification must
report `installedOnly: true`, `sourceFallback: false`, exact source/artifact/
package/evidence roots, and the full restart/replacement/rollback/remove
lifecycle.

## Maintainer qualification

```sh
./shifu test:kfx-github-webhook-reference
./shifu qualify:kfx-github-webhook-real-canary -- \
  --repo OWNER/REPO --region us-east-1
```

The first command is mandatory and fully offline. The second prints a
non-mutating plan by default. Its `--execute` form is a bounded real GitHub ping
canary and requires an explicit credential-rotation confirmation; see the
canary guide before running it.

## Troubleshooting

- `sdk-root-mismatch`: discard the drifted scaffold and recreate it with the
  same installed product version. Do not copy an SDK from the repository.
- `KF_KFX_*_STALE`: re-inspect and re-plan against the current exact roots; do
  not reuse old authority.
- Signature, replay, allowlist, saturation, timeout, or dependency-revocation
  failures: retain the stable refusal code and roots, never the payload,
  signature, or secret.
- Dogfood unavailable: keep the bridge dormant. Generic ingress and the event
  view remain valid; no fallback may admit an Issue, mutate Work/GitHub, or
  claim semantic completion.

## Remove everything

Use `kungfu kfx remove KEY --authority-file OWNER-WARRANT.json` for installed
packages. Removal deletes the managed install path while retaining a dormant
append-only lifecycle record. For a real canary, the tool removes the webhook,
HTTP API, Lambda, IAM role, and exact log group and fails unless the absence
checks pass. It retains only a redacted rooted receipt.
