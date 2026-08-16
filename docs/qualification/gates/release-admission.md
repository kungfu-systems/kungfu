# Kungfu release admission

Kungfu product publication is deny-by-default. The project policy is
[`release-admission-policy.json`](./release-admission-policy.json); the
independent consumer verifier is
[`scripts/verify-kungfu-release-admission.mjs`](../../../scripts/verify-kungfu-release-admission.mjs).
The verifier delegates the project-neutral sealed publication protocol to the
exact Buildchain runtime declared by the policy, then independently rechecks
Kungfu's current Gate registry, release profile, workflow authority, channels,
product identity, and required Linux/macOS/Windows coverage.

## Required evidence

A qualifying capability must bind all of the following exact values:

| Dimension | Required proof |
| --- | --- |
| Source | one 40-character Kungfu revision and its release-candidate tree |
| Gate policy | current `shifu.gates.json`, pre-publication `release-promotion` matrix digest, complete passing rows and platform receipts; the post-publication `layers.release` public-coordinate verdict remains a separate authority |
| Runtime | Alpha consumer tooling uses `@kungfu-tech/buildchain@3.0.9-alpha.16` with its own package contract digest; stable admission remains isolated behind `@kungfu-tech/buildchain-stable@3.0.7`. The installed tooling contract is verified separately from the workflow runtime contract so a published consumer package cannot silently rewrite the accepted floating-runtime lock. Workflow routing keeps the deployed floating contracts: stable uses `v3` at `81c49578bff72a9784a1b63ce8698bd9dd23d7bf`, while Alpha selects `v3-alpha` at `82701ca66f5366ade6ec694c9950d5d8d6db082d`; sealed-candidate recovery binds that reviewed Alpha publication runtime exactly. Candidate build sources retain the floating channel contract rather than a committed exact-SHA override, and the contract locks record the actual resolved digest as immutable evidence. Buildchain keeps full-history ancestry visible, binds source and artifact coordinates, performs the pre-upload transport smoke, and signs or notarizes declared product artifacts through its credential island. Consumer repositories declare artifacts only; they do not own certificate environments, secrets, or signing jobs. The standalone Shifu tool pin remains tracked separately in `.buildchain-version`. |
| Controller | qualifying source/runtime-bound Buildchain controller receipt referenced by the RC passport |
| Runner | qualifying ephemeral, reimaged, or measured persistent-runner provenance; unqualified is denied |
| Control plane | fresh passing Actions, branch/ruleset, Environment, OIDC, publisher, and runner audit facts |
| Artifact | recomputed manifests and every product payload byte for the exact RC platform set |
| Target | Kungfu Episodes, `github-release:kungfu-systems/kungfu`, exact version, and only `alpha` or `release` |
| Freshness | unique nonce, no replay, and no more than 15 minutes from issue to expiry |
| Temporal path | exact release-provenance object plus either the current direct contract binding or the explicitly composed Buildchain proof projection; repository, source/tree, promotion, artifacts, runtime, contract, qualification, approval, and authority are all rooted |

The verifier ignores a producer's own allow/deny statement. It recomputes the
Buildchain registry, admission, controller, Gate aggregate, runner,
control-plane, manifest, payload, and capability digests. Missing expected
fields are errors, not wildcards. Unreadable external audit state fails closed.

Temporal admission is governed by the immutable fact set referenced by
`temporalAdmission.admissionFacts`. Each active allowance has one proof root
that closes its reason, scope, evidence, authority, and Cut roots. Accepted
contract digests are derived from those active proofs; the
`publicationContractDigests` list is retained only as an exact, mechanically
checked rollback projection. Revoked proofs, orphan roots, implicit
transitivity, ancestry substituted for authority, or any mismatch in the
source, tree, artifact, runtime, contract, proof, authority, or Cut fail closed.

## Three different publication meanings

- **Test evidence publication** uploads logs, receipts, or failure reports. It
  runs even after a failed Windows attempt where the workflow contract says
  `always()`. It never grants product capability.
- **Product artifact publication** writes packages or release assets and
  requires a fresh sealed capability.
- **Channel promotion** moves `alpha` or `release` to an exact already-qualified
  source and requires the same capability chain.

Before publication authority is sealed, the Buildchain Gate controller runs
the source-bound `release-promotion` profile on all four required platforms.
That profile contains only actions that can genuinely complete before
publication. Artifact admission remains an independent Buildchain authority
check, and the seven-layer public-coordinate verdict remains post-publication;
neither is allowed to authorize itself through a circular pre-publication Gate.

The Buildchain controller transports the complete Gate aggregate and sealed
capability into `node scripts/kungfu-release-qualification.mjs`. That predicate
runs with read-only source access and no inherited secrets, OIDC permission, or
provider write permission. It recomputes the current `release-promotion` Gate
closure and emits a deterministic consumer decision. Buildchain seals the
decision, then revalidates the capability, aggregate, predicate identity,
receipt, freshness, nonce, source, artifact, version, channel, and target before
provider mutation. Missing or drifted evidence remains blocked; no no-Gate or
legacy fallback is enabled.

## Verification and diagnosis

Run the static and negative contract suite:

```text
./shifu check:gate-catalog
./shifu test:release-admission
./shifu check:temporal-release-admission
```

To re-qualify the historical Alpha allowance against retained sealed material,
use the read-only cutover task with the original archive directory and its
already reconstructed candidate directory:

```text
./shifu release:temporal-provenance:qualify \
  --artifact-root /path/to/original-alpha-archives \
  --reconstruction-root /path/to/reconstructed-candidate \
  --output /tmp/kungfu-temporal-provenance-cutover-qualification.json
```

The task hashes the retained inputs and verifies byte identity, provenance,
fact authority, admission, rollback projection, and orphan closure. It does not
build, reconstruct, publish, promote, retag, or mutate historical evidence.

For a collected evidence directory, invoke the verifier with exact JSON files:

```text
./shifu verify:release-admission \
  --admission admission.json \
  --runner-provenance runner.json \
  --control-plane-audit control-plane.json \
  --publication-evidence publication-evidence.json \
  --expected expected.json \
  --temporal-admission temporal-admission.json \
  --used-nonces used-nonces.json
```

The command prints a `kungfu.release-admission-capability/v1` object only after
the Buildchain protocol, Kungfu policy, and bounded temporal path pass. The
temporal input carries the verified promotion provenance object, promotion SHA,
qualification root, and authority root. The result includes a deterministic
`kungfu.temporal-release-admission-receipt/v1` without private payload. Setting
`KUNGFU_TEMPORAL_RELEASE_ADMISSION_MODE=legacy-exact` is the bounded rollback to
the exact projection derived from the retained active proofs; it never mutates
historical facts or receipts. The command does not publish.
