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
| Gate policy | current `shifu.gates.json`, `release-promotion` matrix digest, complete passing rows and platform receipts |
| Runtime | Stable release authority remains `@kungfu-tech/buildchain@2.14.1`; dev/MQ telemetry uses the isolated npm alias `@kungfu-tech/buildchain-alpha@npm:@kungfu-tech/buildchain@2.14.17-alpha.3`. `alpha` binds `v2-alpha` at `f6f2428e8de6e7d39ca6177cd0686f16a1258515`, while `release` remains isolated on `v2` at `bb9ce34b368c6b5a27b00fbdcb0515076abd9744`, each with its exact contract lock and digest; the standalone Shifu tool pin is tracked separately in `.buildchain-version` |
| Controller | qualifying source/runtime-bound Buildchain controller receipt referenced by the RC passport |
| Runner | qualifying ephemeral, reimaged, or measured persistent-runner provenance; unqualified is denied |
| Control plane | fresh passing Actions, branch/ruleset, Environment, OIDC, publisher, and runner audit facts |
| Artifact | recomputed manifests and every product payload byte for the exact RC platform set |
| Target | Kungfu Episodes, `kungfu-product`, exact version, and only `alpha` or `release` |
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
