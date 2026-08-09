# Assignment Runtime source and contract evidence

## Claim boundary

- Contract: `framework/assignment-runtime/assignment-runtime.contract.json`
- Envelope schema:
  `framework/assignment-runtime/schema/assignment-runtime-envelope-v1.schema.json`
- Runnable cases:
  `framework/assignment-runtime/fixtures/contract-cases-v1.json`
- Decision: `KF-ADR-019fdb93-19ac-7362-8ab0-f8ed19c7bef8`

The Assignment Runtime is Kungfu's native protocol for captured work. Capture,
admission, execution, review, continuation, and settlement use only current
Kungfu identities and schemas. External coordinators consume the public
contract; they do not contribute command names, storage paths, identity aliases,
or reader behavior to Kungfu.

## Current authority inventory

| Surface | Authority | Contract boundary |
| --- | --- | --- |
| Capture | `framework/assignment-capture/assignment-capture.mjs` | immutable pre-admission request and receipt |
| Local Runtime | `framework/core/src/python/kungfu/assignment_runtime/` | sole Assignment state writer |
| CLI | `framework/core/src/python/kungfu/cli/commands/assignment.py` | native commands and exact request/response envelopes |
| Work Control | `extensions/work-control/` | Initiative, Assignment, WorkRef, and Portfolio semantics |
| Agent | `framework/core/src/python/kungfu/agent/` | capability discovery and native Assignment invocation |
| GUI and TUI | Work Control Profile projections | read current public envelopes; no separate writer |
| Sealed state | `assignment_orchestration.py` | exact-root, path-independent settlement witness |
| Physical Home | `framework/core/src/python/kungfu/storage/service.py` | private implementation state, never a public file API |

There is one identity vocabulary and one current reader. No consumer-specific
alias, deprecated schema reader, compatibility projection, or source-checkout
fallback participates in Assignment authority.

## Runnable fixture matrix

| Case | Expected behavior |
| --- | --- |
| `snapshot-success` | current realm generation, revision, roots, references, and receipt are returned |
| `stale-revision` | command fails before mutation |
| `duplicate-command-replay` | original receipt is returned for the same idempotency key and body |
| `unsupported-capability` | negotiation fails within the declared capability set |
| `malformed-identity` | identity is rejected before dispatch |
| `ambiguous-identity` | conflicting current identities are rejected rather than guessed |
| `backend-unavailable` | diagnostics expose native recovery operations; no alternate writer is selected |
| `event-resume-gap` | an expired cursor returns a recovery snapshot revision |
| `authority-bypass` | backend-specific caller mutation is rejected |

## Verification boundary

The semantic validator proves envelope shape, capability negotiation, revision
fencing, idempotency, rooted cursors, diagnostics, and recovery behavior. Runtime
and product completion additionally require the source gate, focused Python and
Node tests, product build, installed CLI inspection, and runtime zero-residue
scans. A source-only pass is not installed-product evidence.
