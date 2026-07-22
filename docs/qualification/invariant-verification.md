# Invariant Verification

This page is the human projection of the same contract and registry consumed
by the runner. It describes how to inspect the claims, run checks, qualify one
Episode object, aggregate a release passport, and interpret failures.

## Discover claims

```sh
./shifu invariant:verify -- --list
./shifu invariant:verify -- --list --json
```

Both commands expose the same ids, owners, source pointers, stability classes,
maturity, checker routes, release matrix, and residual risks. The JSON form is
the cold-start Agent API.

## Run checks

The safe default runs source binding only:

```sh
./shifu invariant:verify
./shifu invariant:verify -- --domain fact --level source --json
```

Run built/native and runtime checks explicitly:

```sh
./shifu invariant:verify -- \
  --domain episode \
  --level source,native,runtime \
  --profile mvp-smoke-v1 \
  --evidence-dir product/release/qualification/invariants/local \
  --json
```

Exit codes are stable:

| Exit | Meaning |
| ---: | --- |
| `0` | selected checks are verified (explicit not-applicable results do not masquerade as checks) |
| `1` | at least one invariant was falsified |
| `2` | evidence is applicable but unqualified, missing, stale, or invalid |
| `3` | usage or runner failure prevented a trustworthy verdict |

## Qualify one Episode object

First obtain the typed read-only Episode qualification result through the
runtime/API surface. Then seal an object receipt:

```sh
./shifu invariant:verify -- \
  --qualify-episode /tmp/episode-qualification.json \
  --receipt /tmp/episode-object-receipt.json \
  --json

./shifu invariant:verify -- \
  --verify-receipt /tmp/episode-object-receipt.json \
  --subject /tmp/episode-qualification.json \
  --json
```

An ended, aborted, or tombstoned object with an `ok` typed qualification and
complete evidence may be `verified`. Open, missing, dangling, or degraded
objects are `unqualified`. A demonstrated integrity/closure failure is
`falsified`. The receipt lists safe capabilities and blockers; it does not
perform repair.

## Aggregate release evidence

Every release platform writes evidence under
`product/release/qualification/invariants/<platform>`. After all exact artifacts
are downloaded, aggregate them from a clean checkout:

```sh
./shifu invariant:verify -- \
  --collect-evidence product/release/qualification/invariants \
  --passport product/release/qualification/invariant-passport.json \
  --json
```

The passport is `verified` only when every registry-required
invariant/layer/platform coordinate is present, current, untampered, and
verified. The same passport also contains
`releaseClaims` for Exit and provider migration. That section:

- re-hashes the retained clean-runtime and provider-migration reports;
- requires the current candidate archives to match the installed-product
  artifact digest in those reports;
- binds the accepted ADR and Exit contract status;
- records the full-only profile, exact platform applicability, required
  providers, downgrade behavior, residual risks, and next action;
- fails closed when evidence or artifacts are missing, stale, tampered,
  thin-only, platform-mismatched, provider-unavailable, or status-drifted.

With no platform override, all release-required platforms are evaluated. A
single-platform admission may explicitly pass
`--release-target-platform darwin-arm64`; this does not qualify other
platforms. Both human output and `--json` are rendered from the same passport
object and therefore carry the same verdict, limitations, diagnostics, and
next actions.

The completed passport is passed to Buildchain as an invariant passport input.
Buildchain validates its root and verified verdict and projects the result into
the Release Passport; it does not reinterpret Exit or migration semantics.

## Adversarial qualification

`./shifu test:invariant-system` proves the control plane fails on:

- source, model, refinement, registry, checker, object, and passport root drift;
- unknown verdicts and checkers;
- missing model/refinement on strong invariants;
- platform omission and unqualified evidence;
- missing, stale, tampered, thin-only, platform-mismatched, and
  provider-unavailable Exit/migration release claims;
- ADR and Exit contract status drift;
- explicit falsifiers;
- object damage, open lifecycle, stale subject, and receipt tamper;
- semantic change without a successor;
- strong successor without model and refinement impact.

The cross-platform release run supplies execution evidence, while these source
fixtures prove the gate logic itself can be falsified. Neither is described as
a complete formal proof.

## Current proof boundary

The source contract and adversarial control-plane suite are implemented and
portable. Exit continuation and provider migration are product-qualified only
for the retained macOS ARM64 full CLI artifact. Linux x64, Windows x64, thin
bundles, GUI/TUI parity, cross-machine migration, distributed writer fencing,
destructive cleanup, and physical-media durability remain unqualified.
Native/runtime claims are release-qualified only after the exact macOS ARM64,
Linux x64, and Windows x64 evidence matrix is present in one clean passport.
`battle-tested` remains unavailable without separately retained
production-operation evidence.
