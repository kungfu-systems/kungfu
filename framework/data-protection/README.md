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

## Current boundary

This slice freezes and tests the contract. Domain adapters, installed-product
migration, user-facing history surfaces, and cross-release qualification are
staged separately. The contract does not inspect or mutate a real `.kungfu`
home, and it does not claim protection against physical media loss.

Verify the contract and its adversarial corpus with:

```sh
./shifu check:data-protection-contract
```
