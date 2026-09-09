# Invariant Verification System

Kungfu verifies Fact and Episode invariants through one control plane without
moving their meaning into that control plane.

```text
authoritative domain contract + domain model
  -> content-addressed registry pointer
  -> source / native / runtime checker
  -> invariant evidence envelope
  -> implementation passport or Episode object receipt
  -> Buildchain Release Passport admission
```

The machine contract is
[`framework/spec/invariant/kungfu-invariant-system.contract.json`](../../framework/spec/invariant/kungfu-invariant-system.contract.json).
The registry is
[`framework/spec/invariant/kungfu-invariant.registry.json`](../../framework/spec/invariant/kungfu-invariant.registry.json).

## Ownership boundary

| Layer | Owns | Does not own |
| --- | --- | --- |
| Fact contract/model | Fact identity, Cut, CAS, root, and historical-reader meaning | runner scheduling or release formatting |
| Episode contract/model | causal closure, dependency, sealed identity, and capability contraction meaning | destination admission or release formatting |
| Invariant registry | discovery, classification, exact source/model/refinement roots, checker routing, required matrix | copied domain rules |
| Runner | bounded execution and evidence envelopes | inferred semantics or silent skip policy |
| Object receipt | one exact Episode's qualified capabilities and blockers | implementation or admission status |
| Invariant Passport | implementation evidence completeness | any one Episode object's integrity |
| Buildchain | release-level collection, audit, and fail-closed admission | Kungfu domain semantics |

The registry's source pointer and root are the anti-drift weld. The runner
resolves the pointer again and recomputes its root before a source verdict can
be `verified`.

## Stability and maturity

Stability answers how semantics may change. Maturity answers how much evidence
exists. They cannot upgrade one another.

| Stability | Responsibility |
| --- | --- |
| `constitutional` | Object identity or safety meaning that survives mechanism replacement |
| `protocol` | Versioned bytes, state transitions, or interoperability rules |
| `profile` | A named environment/workload envelope |
| `policy` | A selected decision rule that may change through declared policy evolution |

| Maturity | Minimum interpretation |
| --- | --- |
| `declared` | authoritative statement exists |
| `falsifiable` | named counterexample path exists |
| `independently-conformant` | an independent model/reader/oracle agrees inside scope |
| `qualified` | declared candidate profile completed |
| `release-enforced` | release admission requires current complete evidence |
| `battle-tested` | separately retained production-operation evidence supports the claim |

## Evidence roots

Evidence roots exclude only observation time and duration. They include source,
contract, registry, checker, platform, profile, witness, verdict, and residual
risk. Repeating the same semantic observation can therefore retain the same
root even when wall-clock timing differs.

Passport and object-receipt roots follow the same rule. A receipt verifier
recomputes both the receipt root and its current subject/contract/checker roots.

## Safe execution

The default public run selects `source` only. Native and runtime checks must be
selected explicitly because they may need built artifacts and can be expensive.
Missing prerequisites produce `unqualified`, never `verified` or an implicit
skip.

The release workflow explicitly selects `source,native,runtime` on every
declared platform and retains the resulting evidence. Object qualification is
read-only and accepts the typed `kungfu.episode.qualification/v1` result; it
does not repair an Episode.
