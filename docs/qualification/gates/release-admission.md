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
| Runtime | Stable release authority is `@kungfu-tech/buildchain@3.0.0`; dev/MQ telemetry uses the isolated npm alias `@kungfu-tech/buildchain-alpha@npm:@kungfu-tech/buildchain@3.0.6-alpha.1`. `alpha` explicitly accepts the protected artifact-signing and pre-upload transport-smoke authority at `2e7e07902ac28d8f3edcfb81098ef9ebc7a91878` (`3.0.5-alpha.6` source): its full-history locked checkout keeps ancestor-bound KFD evidence visible beneath regenerated pull-merge commits, its declarative auditable Demo surface binds that evidence to the exact artifact coordinate, its transport smoke executes the restored digest-bound binary closure before either upload path, and deterministic GitHub-hosted payloads retain manifest-bound dotfiles. The signing controller binds the exact source run attempt and accepts GitHub's exact bare authority workflow path as well as its ref-qualified form, while rejecting every foreign path. Its native matrix independently routes offline self-hosted Linux, macOS, and Windows lanes to fixed GitHub-hosted images, and every declared binary or application artifact is signed and notarized inside Buildchain's central credential island before the exact final bytes are verified on GitHub-hosted infrastructure. Final signing metadata is bounded to controller-declared platform manifests, while credential-island manifests use a separate artifact namespace. Consumer repositories declare artifacts only; they do not own certificate environments, secrets, or signing jobs. `release` remains isolated on `v3` at `9e904de2c85dbea7c799780ee166510b3336d812`; each channel retains its exact contract lock and digest, and the standalone Shifu tool pin is tracked separately in `.buildchain-version` |
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
