# C++ error-handling policy

Kungfu's core is C++23 + Rx ([ADR-0082](../adr/ADR-0082-cpp23-rx-core-language-strategy.md)).
Error handling is not one mechanism applied everywhere; it is a written
three-tier policy that matches the mechanism to where the failure is handled.
Choosing the wrong tier is what produces either silent corruption or an
unreadable tangle of `try`/`catch`, so the tier is a design decision, not a
matter of taste.

## The three tiers

### Tier 1 — exceptions at the loop / ring boundary

Deep call paths that can fail for many unrelated reasons throw, and the
exception is caught once at the owning boundary — the reactor loop, the single
writer's publish path, an owned ring. The boundary decides liveness (stop,
degrade, retry) with local stop ownership; intermediate frames stay free of
error plumbing. This is the default for the runtime's control flow.

Use tier 1 when the failure means "this unit of work cannot continue" and the
only sensible reader is the boundary that owns the loop.

### Tier 2 — `std::expected` at classify-and-continue seams

Some seams must *not* unwind to a loop boundary: they have to classify a failure
into a domain outcome and keep serving. Here the throwing region is captured
once as a value and mapped through a single central classifier with
`std::expected` + `transform_error`, instead of a hand-maintained `catch`
ladder repeated at every such seam. One classifier is the single source of truth
for how an exception type projects onto the domain's error code, so the mapping
cannot drift between seams.

The reference implementation is the durability barrier commit path in
[`durable_ingest.cpp`](../../framework/core/src/libkungfu/src/runtime/durable_ingest.cpp)
(`barrier(...)`):

```cpp
// Capture the throwing commit body once; the body's own early returns stay
// values (a valid timeout / unsupported-profile outcome is not an error).
auto outcome = capture_ingest_exception([&]() -> barrier_result {
  // ... commit path that throws through native_file / fence validation ...
  return complete_result();
}).transform_error(classify_durability_failure); // exception_ptr -> ingest_failure

if (outcome) {
  return *outcome;                 // success or a valid early return
}
const ingest_failure &failure = outcome.error();
// project the classified failure onto status + receipt, then continue serving
result.receipt.status = receipt_status::Unknown;
```

`classify_durability_failure` is the only place that rethrows-and-catches:
`std::logic_error` → fencing lost, `std::system_error` → I/O error, anything
else → injected/unknown fault, each surfaced as a `ServiceUnavailable` receipt
with an `Unknown` outcome. Adding a new seam reuses that classifier rather than
copying a ladder.

Use tier 2 when a failure must become a returned domain outcome (an error code,
a receipt) and the caller keeps running.

### Tier 3 — value-style scan paths

Hot scan and decode paths — offline manifest scanners, replay/fold, the
storage registries — do not throw for expected-but-unknown inputs. An unknown
record is a designed state, represented as a value and handled with an explicit,
exhaustive branch. The compile contract enforces the exhaustiveness: closed-enum
`switch` is `-Werror=switch` / `/we4062`, and the registry welds check
membership at compile time. A deliberate `default` arm stays legal precisely so
these downgrade paths can name the unknown case (see
`source_registry_unknown_record`); `-Wswitch-enum` / C4061, which would outlaw
those arms, is intentionally off.

Use tier 3 on paths where failures are frequent, expected, and part of the
data model rather than exceptional.

## Choosing a tier

| Question | Tier |
| --- | --- |
| "This unit of work must stop; the loop boundary decides." | 1 — exception to the boundary |
| "This must become a domain outcome and we keep serving." | 2 — `expected` + central classifier |
| "Unknown input is normal here; branch on it." | 3 — value + exhaustive `switch` |

The tiers are not ranked by preference. A commit path uses all three: it throws
through its helpers (tier 1 mechanics), the seam classifies once (tier 2), and
the scanners it feeds branch on unknown records (tier 3).

## Related

- [ADR-0082 — C++23 + Rx core language strategy](../adr/ADR-0082-cpp23-rx-core-language-strategy.md)
- [C++ toolchain contract](cpp-toolchain.md) — the compile contract that enforces tier 3 exhaustiveness
- Contributor workflow: [CONTRIBUTING](../../CONTRIBUTING.md)
