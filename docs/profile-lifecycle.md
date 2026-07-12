---
status: draft
period: 2026-07-13
theme: kfx-profile-lifecycle
doc_type: product-contract
source_level: local-files + architecture-decision
confidence: high
sensitivity: public
evidence_grade: A
review_state: self-reviewed
last_reviewed: 2026-07-13
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-13
  invisible_context_boundary: Later Agent SDK, GUI, portability, and semantic qualification behavior are not implemented here
---

# KFX Profile Suite lifecycle

The S1 Profile lifecycle turns a schema-valid `kungfu.profile-suite/v1`
document into append-only workspace facts without making Profile JSON, a GUI,
or an extension package a runtime authority.

## Authority and identity

Core embeds the exact `kungfu-kfx.contract.json` document and validates its
`profileSuiteSchema`. Inspection then verifies every referenced artifact's
SHA-256 and confines real paths to the Profile package directory. The caller
must also supply one canonical `sha256:...` root for every required and
optional Suite member; missing, extra, malformed, or changed roots fail closed.

Core computes `profile_suite_root` over:

- the normalized Profile document;
- the exact KFX source-contract root;
- every verified facet path, SHA-256, and byte length;
- every resolved Suite member root.

The source cannot declare its own Profile root. Whitespace and input member
ordering do not change identity; content, authority-contract, or member-root
changes do.

## Lifecycle facts

`Installed`, `Qualified`, `Activated`, `Superseded`, `RolledBack`, and
`Removed` are FlatBuffers-owned events inside an ActionEnvelope. Each event is
attached to an Episode and appended under the workspace runtime journal at
`profile/lifecycle`. Current state and historical cuts are deterministic folds
over that journal; no `profile-catalog.json` sidecar is authoritative.

Installed, qualified, and activated are distinct. Activation requires the
exact current root to have a prior qualification fact and refuses grants not
declared by a bound `kungfu.profile-permissions/v1` registry. GUI focus is not a
lifecycle state. Multiple Profiles may remain active in one workspace.

The S1 qualifier executes only two checks:

- `content-closure`;
- `runtime-contract`.

The bound compatibility artifact must use
`kungfu.profile-compatibility/v1` and include
`kungfu.profile-lifecycle/v1`; the qualification artifact must use
`kungfu.profile-qualification/v1` and request exactly those two supported
checks. Unsupported checks fail instead of being reported as passed.

## Plan and apply

All mutations use the same operation from C++, Python, Node, and CLI:

```text
inspect -> plan -> authorize -> apply -> receipt -> get/history
```

`plan` records the target runtime, current root/revision, verified inspection,
permissions, qualification result, and typed effects. `apply` requires an
authorization id, recomputes the plan, and rejects any change in source bytes,
member roots, current lifecycle basis, permissions, target runtime, or plan
identity.

Use `kungfu kfx profile --help` for the installed CLI. `get
--cut-system-time` reads the historical fold; `history` retains lifecycle facts
after rollback or removal.

## Current boundary

This is the generic artifact/lifecycle runtime, not the complete Profile
product. It does not yet provide scaffolding, semantic fixture execution,
Profile export/import, Profile Manager GUI, generic domain rendering, Mission
Control migration, or Week/Day release qualification. A lifecycle receipt
proves the recorded transition and bound closure, not the truth of a domain
claim or fitness for a user's purpose.
