---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0027
decision_status: accepted
implementation_status: partial
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0027: Python yijinjing schema exposes only core public runtime types

## Status

accepted

## Context

ADR-0026 narrowed Python `pykungfu.runtime` to raw/envelope runtime APIs, but
`pykungfu.yijinjing.types` still bound every generated `AllDataTypes` class. That
kept old trading and profile schemas visible as first-class Python API:
`Order`, `Trade`, `Quote`, `Asset`, `Position`, `RiskSetting`, `Commission`,
`Instrument`, and related request/history types still appeared in committed
stubs and autocomplete.

That public shape conflicts with the v4 direction:

- action/business semantics belong in envelopes, not one Python class per old
  product-domain schema;
- `AllTypes` and `AllDataTypes` must represent the current core-only compiled
  registry, not a back door for old trading/profile schemas;
- Python bindings should wrap the C++ core action-recording surface, not rebuild
  a trading-specific API layer above it.

## Decision

Add `yijinjing::CorePublicDataTypes` as the C++ registry for Python public
`pykungfu.yijinjing.types` bindings. It contains only neutral runtime/core data
structures such as frame/page headers and location/register data,
channel/read/write requests, cache coordination, state updates, and time values.

Add matching Python-public subsets for state and profile bindings:

- `CorePublicStateDataTypes` for `pykungfu.yijinjing.state`;
- `CorePublicProfileDataTypes` for `pykungfu.runtime.profile`.

Change the Python yijinjing schema type binding to iterate `CorePublicDataTypes` instead
of `AllDataTypes`; change the Python state/profile bindings to iterate the new
core-public subsets instead of the internal cache registries.

Keep `AllTypes` and `AllDataTypes` in C++, but redefine them as the current
core-only registry used by the Node journal decoder, replay writer, console
dump, and raw frame restore paths. Remove the `LegacyCompiled*` aliases so new
code cannot preserve or copy the old compatibility vocabulary.

Remove the old Node profile-store exports (`RiskSettingStore`,
`CommissionStore`, `BasketStore`, and `BasketInstrumentStore`) and the Python
yijinjing schema enum bindings for trading/profile concepts. The Python public enum
module now exposes only neutral runtime enums.

Remove the typed trading mode from the dispatch load benchmark so the benchmark
does not force `Quote` to remain a Python public type.

Extend `scripts/check-runtime-greenfield.mjs` to block:

- Python yijinjing schema binding code that returns to `AllDataTypes`;
- committed Python stubs that expose old trading/profile typed classes;
- benchmark code that depends on Python trading typed bindings.

## Consequences

- Python v4 users see the core runtime structures that are still part of the
  polyglot membrane, not the historical trading domain object model.
- Raw frame transport and action envelopes remain the Python path for business
  facts.
- Node/diagnostic compatibility uses the narrowed core registry and raw frame
  primitives, not old profile-store exports.
- Generated stubs now act as a regression surface: if a future build exposes the
  legacy types again, the greenfield gate fails.
- The internal profile/cache public surface is removed from Python and Node.
  Future config APIs should be defined as neutral v4 runtime contracts instead
  of reviving old trading tables.

## Alternatives Considered

- **Delete `AllDataTypes` immediately.** Rejected because raw frame decode,
  replay writer matching, and console dumps still need a compiled core registry.
  The chosen path is to make that registry core-only instead of deleting the
  registry abstraction.
- **Expose profile/cache schemas because old state cache code once stored
  them.** Rejected for public API. Future config/state storage should define
  neutral v4 contracts rather than preserve historical trading tables.
- **Leave the benchmark in typed mode.** Rejected because test utilities shape
  developer expectations; keeping `Quote` there would preserve the exact API we
  are retiring.
