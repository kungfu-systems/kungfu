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
| Runtime | Alpha consumer tooling uses `@kungfu-tech/buildchain@3.0.9-alpha.17` with its own package contract digest; stable admission remains isolated behind `@kungfu-tech/buildchain-stable@3.0.7`. The installed tooling contract is verified separately from the workflow runtime contract so a published consumer package cannot silently rewrite the accepted floating-runtime lock. Promotion routing keeps the deployed floating contracts: stable uses `v3` at `81c49578bff72a9784a1b63ce8698bd9dd23d7bf`, while Alpha selects `v3-alpha` at `a5f43da50ea4ad5138ccf901135b89a711a1780c`; sealed-candidate recovery binds that reviewed Alpha publication runtime exactly. Privileged candidate builds pin both the reusable workflow shell and every executed Buildchain runtime byte to the same reviewed SHA; `v3-alpha` and `v3` are retained only as recorded channel and major identities, never as executable refs in that credentialed path. Contract locks record the reviewed revision and resolved channel digest as immutable evidence. Buildchain keeps full-history ancestry visible, binds source and artifact coordinates, performs the pre-upload transport smoke, and signs or notarizes declared product artifacts through its credential island. Consumer repositories declare artifacts only; they do not own certificate environments, secrets, or signing jobs. The standalone Shifu tool pin remains tracked separately in `.buildchain-version`. |
| Controller | qualifying source/runtime-bound Buildchain controller receipt referenced by the RC passport |
| Runner | qualifying ephemeral, reimaged, or measured persistent-runner provenance; unqualified is denied |
| Control plane | fresh passing Actions, branch/ruleset, Environment, OIDC, publisher, and runner audit facts |
| Artifact | recomputed manifests and every product payload byte for the exact RC platform set |
| Target | Kungfu Episodes, `github-release:kungfu-systems/kungfu`, exact version, and only `alpha` or `release` |
| Freshness | unique nonce, no replay, and no more than 15 minutes from issue to expiry |
| Temporal path | exact release-provenance object plus either the current direct contract binding or an explicitly composed path through selected Buildchain compatibility Facts; every Fact and path receipt is rooted, and repository, source/tree, promotion, artifacts, runtime, contract, qualification, approval, and authority are all bound |

The verifier ignores a producer's own allow/deny statement. It recomputes the
Buildchain registry, admission, controller, Gate aggregate, runner,
control-plane, manifest, payload, and capability digests. Missing expected
fields are errors, not wildcards. Unreadable external audit state fails closed.

Temporal admission is governed by the immutable Fact set referenced by
`temporalAdmission.admissionFacts` and the protected Buildchain Fact projection
referenced by `temporalAdmission.compatibilityFacts`. Each active allowance has
one proof root that selects exact Buildchain Fact roots. The verifier validates
their predicates, relations, protected Cut, registry root, target surfaces, and
individual KFR2 path receipts before it can authorize a contract. Runtime
`contractProjection` objects are mechanically derived, explicitly
non-authoritative diagnostics; normal admission never reads them as an
allowlist. Revoked proofs, unselected or orphan Facts, implicit transitivity,
ancestry substituted for authority, or any mismatch in the source, tree,
artifact, runtime, contract, Fact, authority, or Cut fail closed.

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
digest-list fallback is enabled.

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
Fact authority, admission, and orphan closure. It does not
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
`KUNGFU_TEMPORAL_RELEASE_ADMISSION_MODE` is rejected; normal admission has only
the `fact-only` mode. The command does not publish.

The retired exact-digest behavior is retained only in the independently sealed
`framework/release/kungfu-temporal-release-rollback.contract.json`. It is not
eligible for normal admission and cannot be selected through an environment
variable. An operator may reproduce its retained decision offline with an
explicit request file:

```text
./shifu rollback:temporal-release-admission --request request.json
```

That command verifies the rollback seal, retained source proof root, exact
release provenance, and bindings. The request supplies only
`releaseProvenance` and `bindings`; contracts and admission Facts are always
loaded from the checked workspace and cannot be substituted by the caller. Its
receipt always declares `normalAdmissionEligible: false` and
`externalPublicationClaimed: false`.
