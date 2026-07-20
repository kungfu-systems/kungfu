---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0118
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/1142]
qualification_refs: [framework/action/cli-topology.contract.json, framework/core/src/python/kungfu/cli/commands/dev.py, framework/core/src/python/kungfu/cli/surface_contract.registry.json, framework/core/tests/fixtures/cli-canonical-alias-migration.json, framework/core/tests/python/test_cli_surface_contract.py, framework/core/tests/python/test_xinfa_command.py, framework/core/tests/python/test_action_primitive_role_commands.py, xinfa/qualification/standalone-smoke-v1.json]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-19
theme: kungfu-single-entry-action-primitive-cli
confidence: high
evidence_grade: B
last_reviewed: 2026-07-20
ai_provenance: GPT-5 via Codex on 2026-07-19; based on repository sources and user-authorized product constraints; no claim about unpublished release artifacts or unobserved platform behavior
---

# ADR-0118: Kungfu is the only public Action Primitive CLI entrypoint

- Status: accepted; implementation staged
- Date: 2026-07-19
- Category: CLI topology / Action Primitive product / Xinfa distribution
- Supersedes: the public-CLI portions of [ADR-0092](ADR-0092-xinfa-product-and-incubation-boundary.md) and [ADR-0095](ADR-0095-xinfa-atlas-primitive-and-compatibility-boundary.md)
- Preserves: Xinfa ownership and clean extraction from ADR-0092, Xinfa Atlas identity from ADR-0095, and the Action host membrane from [ADR-0117](ADR-0117-action-mjs-dual-host-kernel-bootstrap.md)

## Context

Kungfu v4 is distributed to people and Agents as one CLI product. Publishing a
second `xinfa` executable would make users choose between product entrypoints
before they understand the underlying roles, and would make one-shot Agent
onboarding incomplete. At the same time, folding Xinfa semantics into Click or
Core would destroy its independent schema, state, version, engine, and clean
extraction boundary.

## Decision

### 1. The public command tree has one executable

The terminal user installs and remembers only `kungfu`:

```text
kungfu
├── agent brief
├── xinfa compile
├── atlas capabilities|inspect|action
├── pursuit capabilities|inspect|action
├── warrant capabilities|inspect|action
└── episode capabilities|inspect|action
```

`kungfu xinfa compile` compiles the current workspace's
`.xinfa/project.json` into `.xinfa/atlas` and emits the JSON receipt unless an
explicit project, pack, root, workspace, output, or output mode is supplied.
Public Atlas lifecycle shortcuts map to the corresponding Xinfa Atlas engine
commands. There is no installed PATH launcher named `xinfa`.

### 2. Xinfa remains an independent engine, not a second user product entry

Xinfa continues to own `xinfa.*` schemas, `.xinfa` state and cache, its Cargo
version, compiler implementation, diagnostics, roots, receipts, and extraction
manifest. The installed archive carries its physical binary at a private,
manifest-bound engine path. The `kungfu xinfa` adapter only normalizes the
workspace Atlas shorthand and propagates engine stdout, stderr, and exit code.

The extracted physical binary and `./shifu xinfa` remain qualification and
source-development entries. They are not advertised as terminal-user product
entrypoints. Standalone qualification proves separability and semantic
ownership; it does not require a second public command.

### 3. Four role groups project one existing Profile engine

Atlas, Pursuit, Warrant, and Episode each expose capabilities, inspection, and
versioned action planning/execution under `kungfu`. These Click groups do not
copy transition tables or mutate storage directly. They select one role and
delegate to the existing KFD-7 `work_profile`, whose mutations cross the native
Fact kernel and named-ref CAS.

The existing `kungfu atlas` bridge remains intact. Its new role operations are
additive. Action MJS may later own pure validation, plans, and projections, but
Core remains the authority for identity, journal, CAS, Cuts, receipts, and
mutation.

### 4. `kungfu agent brief` is the complete first read

The installed brief names the only public executable, the compiler command,
the four role groups, authority boundaries, safe discovery path, and explicit
non-claims. It is offline and does not initialize runtime state. Further
capability commands deepen discovery but are not required to learn the command
topology.

## Falsification and acceptance

The decision is false if an installed archive exposes a second top-level
executable, `kungfu xinfa compile` differs from source Xinfa Atlas compilation,
the adapter rewrites engine JSON or errors, a role group accepts another role's
request, Click duplicates Profile transitions, onboarding creates runtime
state, or clean Xinfa extraction stops passing.

Qualification therefore checks the public topology contract, adapter argument
mapping and exit propagation, cross-role rejection, source/product compiler
parity, private engine staging, archive launcher inventory, one-shot brief, and
the existing standalone smoke.

## Version impact

This adds `xinfa.product-contract/v2` and
`kungfu.action-primitive-cli/v1`. Existing `xinfa.*` object schemas, roots,
state paths, and Xinfa `0.1.0` engine version retain their meaning. The CLI
topology is additive to Kungfu's pre-release v4 line, except that a future
distributed standalone `xinfa` user launcher is now explicitly forbidden.

## Non-claims

This decision does not make ActionBinding a fifth primitive, complete the
generic Warrant product boundary, certify Pursuit completion from an action
receipt, remove Rust Xinfa, or claim every platform archive has passed before
its named product qualification runs.
