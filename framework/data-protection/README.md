# Durable History Data Protection

Kungfu protects semantic history only after the owning domain has accepted it.
The exact boundary is a verified owner-domain success receipt plus a stable
identity and root. Starting a command, rendering a row, opening an Agent
session, writing a transcript, or caching provider activity does not cross that
boundary.

The machine authority for this policy is
[`kungfu-data-protection.contract.json`](kungfu-data-protection.contract.json).
It defines one retention taxonomy, a domain authority registry, an
entrypoint-to-authority matrix, and fail-closed compatibility, migration, loss,
and garbage-collection rules. It is a composition policy, not another data
store or event log.

## One member, one owner

| Protected family | Existing authority retained by the contract | Stable identity/root family |
| --- | --- | --- |
| accepted Work, Decisions, Assessments | Work Control Profile over native Fact and Episode | workspace/Work roots, Fact version roots, sealed Episode roots |
| semantic Facts and Episodes | native Fact kernel and Episode storage service | `kungfu.fact-root.canonical/v2`, Episode manifest `content_root` |
| Project Cuts | Project Cut protocol | `cutRoot`, `serializationRoot`, domain `receiptRoot` |
| Product Release Cuts | Product Release Cut and Cut Transition | `releaseCutRoot`, `platformSliceRoot`, `cutTransitionRoot`, `manifestIdentityRoot` |
| receipts | the domain that issued the typed receipt | issuer receipt root; an evidence envelope preserves but never replaces it |
| schema and interpreter material | each declared owner, composed by portable-format authority | schema bytes, logical root protocol, reader/interpreter root |

Exit Bundle remains the composition seam for export. It inventories exact
domain roots, material closure, omissions, loss, and required capabilities, then
delegates verification to each owner. It does not decode or re-encode member
semantics.

## The protection boundary

Protection begins only when all of these are true:

1. the member kind resolves to exactly one registered family;
2. the current CLI, TUI, GUI, Agent, or Shifu entrypoint routes to that family;
3. the owner receipt and the semantic object identity/root verify;
4. required members, schemas, and interpreters are supported or retained;
5. omissions and loss are explicit and compatible with the claimed status; and
6. the `kungfu.data-protection.admission-receipt/v1` root verifies.

The protection receipt is verification evidence. The referenced owner receipt
and object root remain authoritative.

## Migration and deletion

Supported readers either preserve the existing identity, copy forward into a
new identity with a mapping receipt, or refuse before writing. They never
reinterpret an old root in place or infer compatibility from SemVer, a path, a
timestamp, or a cache.

Garbage collection is plan-only by default. Critical bytes may be removed only
after either an equivalent successor is admitted or an export/import recovery
path passes postflight equivalence. Observer projections and caches may be
rebuilt, but they cannot be the only recovery source.

## Work and Agent entrypoints

[`work-agent-history.contract.json`](work-agent-history.contract.json) applies
the boundary to GUI, TUI, CLI, native Agent UI, managed runs, Skill Envelopes,
KFD, and external Agent UIs. Every surface routes semantic actions to the same
Work/Profile, Fact, and Episode authority. A provider exit, self-report,
WorkConsole row, or retained SessionAttempt is shown as session activity only;
it has no semantic admission receipt and cannot complete Work.

WorkConsole remains an observer projection. Losing its registry can remove a
reattach convenience, but cannot erase or reinterpret accepted Work history.
Compatible history is read under its exact roots or copy-forward migrated with
a mapping receipt in a disposable qualification home. Tests never migrate the
real user home.

## Current boundary

The base contract, Work/Agent adapter, and
[`project-cut-dogfood-history.contract.json`](project-cut-dogfood-history.contract.json)
are source-qualified. Project Cut full members preserve all four owner roots,
verified predecessors/successors, explicit loss, and protected publication
manifests; Native Assignment and Dogfood reuse the existing Fact, Episode,
Profile, and Work authority members rather than creating another store.
The base and owner-specific source-release adapters now include Product Release
Cut portability, specified by
[`product-release-cut-portability.contract.json`](product-release-cut-portability.contract.json):
its Exit member carries verified installed-image bytes and receipt roots without
channel or download caches, then creates a separate copy-forward activation
receipt whose paths belong to the destination. Public and `shifu-local` trust
domains are retained rather than collapsed. User-facing Exit surfaces share
the same Core authority seam. The aggregate
[`durable-history-qualification.contract.json`](durable-history-qualification.contract.json)
is now source-qualified: its disposable campaign covers all declared
entrypoints, clean full and explicitly lossy thin import, predecessor reading,
interruption, cache/worktree loss, rollback, unknown members, and GC, and emits
an exact source/artifact/campaign/review-bound receipt. That source result does
not qualify the installed product, stable release, off-host backup, physical
media, or an unexecuted platform; soak, off-host restore, and platform
expansion remain explicit deferred work. The contract does not
inspect or mutate a real `.kungfu` home. It does not claim protection against physical media loss.

Verify the contract and its adversarial corpus with:

```sh
./shifu check:data-protection-contract
./shifu check:work-agent-history-continuity
./shifu check:project-cut-dogfood-history
./shifu check:product-release-cut-portability
./shifu check:exit-history-surfaces
./shifu check:durable-history-qualification
```
