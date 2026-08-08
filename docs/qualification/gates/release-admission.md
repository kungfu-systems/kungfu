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
| Runtime | Consumer tooling and release promotion retain production `@kungfu-tech/buildchain@3.0.6` and the deployed `v3`/`v3-alpha` routers. Dev/MQ artifact builds and KFD telemetry use the isolated development alias `@kungfu-tech/buildchain-alpha`, bound directly to reviewed Buildchain Git commit `58e48d73ae7fef0dd06ae02baf6d090e4da5487d` (source package version `3.0.6-alpha.10`) rather than a mutable dist-tag or an unpublished package. That exact dev runtime adds the `jit-executable-v1` signing profile required by the standalone macOS CLI archive: only the declared Node and Python executables receive `com.apple.security.cs.allow-jit`, and Buildchain reads the entitlement back before returning evidence. Release promotion remains on the production routers; this dev qualification does not publish, retag, or mutate a stable branch. Consumer repositories declare artifacts and desired signature state only; they do not own certificate environments, secrets, entitlement files, or signing jobs. The standalone Shifu tool pin remains tracked separately in `.buildchain-version`. |
| Controller | qualifying source/runtime-bound Buildchain controller receipt referenced by the RC passport |
| Runner | qualifying ephemeral, reimaged, or measured persistent-runner provenance; unqualified is denied |
| Control plane | fresh passing Actions, branch/ruleset, Environment, OIDC, publisher, and runner audit facts |
| Artifact | recomputed manifests and every product payload byte for the exact RC platform set |
| Target | Kungfu Episodes, `github-release:kungfu-systems/kungfu`, exact version, and only `alpha` or `release` |
| Freshness | unique nonce, no replay, and no more than 15 minutes from issue to expiry |

The verifier ignores a producer's own allow/deny statement. It recomputes the
Buildchain registry, admission, controller, Gate aggregate, runner,
control-plane, manifest, payload, and capability digests. Missing expected
fields are errors, not wildcards. Unreadable external audit state fails closed.

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
```

For a collected evidence directory, invoke the verifier with exact JSON files:

```text
./shifu verify:release-admission \
  --admission admission.json \
  --runner-provenance runner.json \
  --control-plane-audit control-plane.json \
  --publication-evidence publication-evidence.json \
  --expected expected.json \
  --used-nonces used-nonces.json
```

The command prints a `kungfu.release-admission-capability/v1` object only after
both the Buildchain protocol and Kungfu policy pass. It does not publish.
