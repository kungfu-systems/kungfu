# ADR-0026: yijinjing exposes a greenfield core surface, not trading typed helpers

## Status

accepted

## Context

Kungfu v4 is rebuilding the runtime around action recording, envelopes, storage,
fsck/export, and replay. The lower journal layer is still able to carry compiled
longfist frames, but the old v3 convenience surface leaked too much product
meaning into core APIs:

- Python `pykungfu.yijinjing.event` exposed one method per generated longfist
  data type, including `Order`, `Trade`, `Quote`, and related trading types.
- Python `writer` and `assemble` generated one overload per closed longfist data
  type, making typed business frames look like the default v4 write/read path.
- The runtime time API named its session window after `trading_day`, even though
  v4 storage restore only needs a deterministic session/history window.
- `longfist.h` still carried trading/profile closed-set registry names and a
  broad compiled type set that invited new code to copy the old product model.

This conflicts with ADR-0022 and ADR-0025: the C++ core is the polyglot membrane,
and v4 business facts use `carrier_type=1000` plus action envelopes.

## Decision

Narrow the public yijinjing binding surface to neutral runtime primitives:

- event metadata and raw byte/string payload access;
- writer `write_bytes`, `mark`, and action-recorder APIs;
- assemble reads by `carrier_type` into headers or raw bytes;
- neutral time APIs: `next_session_boundary`, `session_window_start`, and
  `history_window_start`.

Remove the Python-generated `AllDataTypes` helper surface from yijinjing. Python
and JavaScript may still bind core runtime structs such as `Location`,
`Register`, `Channel`, or profile/cache structs while the runtime still uses
those internal compiled schemas, but they should not re-create a broad
business-typed journal API.

Remove unused trading/profile closed-set registries from the v4 `longfist.h`
core registry. `AllTypes`, `AllDataTypes`, and `AllTypesTags` now name the
current core-only compiled registry, not a compatibility wrapper around the old
trading surface.

The Node watcher and Node module exports no longer carry the old trading/profile
refresh and profile-store public surface. They maintain only the neutral runtime
state and raw frame primitives required by the v4 view.

Add `scripts/check-yijinjing-greenfield.mjs` to prevent these specific patterns
from returning.

## Consequences

- New Python code records agent/runtime facts through action envelopes and raw
  payload APIs instead of typed trading frame helpers.
- Future language bindings are less likely to fork core action semantics in
  Python or JavaScript.
- The old generated longfist schema files are not fully deleted by this ADR.
  Residual schema definitions may remain in generated headers or historical
  migration spikes until a later schema split removes or moves those definitions
  themselves, but they are no longer part of the core registration or public
  binding surface.
- Current v4 dogfood paths that use Atlas/Rewind/Work action envelopes continue
  to run on the same writer/reader primitives.

## Alternatives Considered

- **Keep typed helpers but document them as legacy.** Rejected because generated
  autocomplete and stubs are stronger than documentation; future code would copy
  the visible helper surface.
- **Delete every historical schema definition in one change.** Rejected for this
  slice because generated schema-file surgery is larger and riskier than
  removing the public/runtime registration surface. The first invariant is to
  stop exposing and extending old trading/profile concepts as core yijinjing
  APIs.
- **Rename everything without a gate.** Rejected because the same closed-set
  helpers can be reintroduced mechanically by future binding regeneration.
