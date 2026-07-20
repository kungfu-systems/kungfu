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
verified. It is then passed to Buildchain as an invariant passport input.

## Adversarial qualification

`./shifu test:invariant-system` proves the control plane fails on:

- source, model, refinement, registry, checker, object, and passport root drift;
- unknown verdicts and checkers;
- missing model/refinement on strong invariants;
- platform omission and unqualified evidence;
- explicit falsifiers;
- object damage, open lifecycle, stale subject, and receipt tamper;
- semantic change without a successor;
- strong successor without model and refinement impact.

The cross-platform release run supplies execution evidence, while these source
fixtures prove the gate logic itself can be falsified. Neither is described as
a complete formal proof.

## Current proof boundary

The source contract and adversarial control-plane suite are implemented and
portable. Native/runtime claims are release-qualified only after the exact
macOS ARM64, Linux x64, and Windows x64 evidence matrix is present in one clean
passport. `battle-tested` remains unavailable without separately retained
production-operation evidence.
