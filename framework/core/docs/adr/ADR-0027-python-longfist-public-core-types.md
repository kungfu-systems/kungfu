# ADR-0027: Python longfist exposes only core public runtime types

## Status

accepted

## Context

ADR-0026 narrowed Python `pykungfu.yijinjing` to raw/envelope runtime APIs, but
`pykungfu.longfist.types` still bound every generated `AllDataTypes` class. That
kept old trading and profile schemas visible as first-class Python API:
`Order`, `Trade`, `Quote`, `Asset`, `Position`, `RiskSetting`, `Commission`,
`Instrument`, and related request/history types still appeared in committed
stubs and autocomplete.

That public shape conflicts with the v4 direction:

- action/business semantics belong in envelopes, not one Python class per old
  product-domain schema;
- `AllTypes` and `AllDataTypes` are legacy compiled registries that still serve
  diagnostics, raw journal decoding, and staged Node compatibility paths;
- Python bindings should wrap the C++ core action-recording surface, not rebuild
  a trading-specific API layer above it.

## Decision

Add `longfist::CorePublicDataTypes` as the C++ registry for Python public
`pykungfu.longfist.types` bindings. It contains only neutral runtime/core data
structures such as frame/page headers, location/session/register data,
channel/read/write requests, cache coordination, state updates, and time values.

Add matching Python-public subsets for state and profile bindings:

- `CorePublicStateDataTypes` for `pykungfu.longfist.state`;
- `CorePublicProfileDataTypes` for `pykungfu.yijinjing.profile`.

Change the Python longfist type binding to iterate `CorePublicDataTypes` instead
of `AllDataTypes`; change the Python state/profile bindings to iterate the new
core-public subsets instead of the internal cache registries.

Keep `AllTypes` and `AllDataTypes` in C++ for now, but treat them as legacy
compiled schema registries rather than a public language API. The Node journal
decoder, replay writer, console dump, and staged watcher compatibility path may
continue to use them until those internals are split or replaced.

Remove the typed trading mode from the dispatch load benchmark so the benchmark
does not force `Quote` to remain a Python public type.

Extend `scripts/check-yijinjing-greenfield.mjs` to block:

- Python longfist binding code that returns to `AllDataTypes`;
- committed Python stubs that expose old trading/profile typed classes;
- benchmark code that depends on Python trading typed bindings.

## Consequences

- Python v4 users see the core runtime structures that are still part of the
  polyglot membrane, not the historical trading domain object model.
- Raw frame transport and action envelopes remain the Python path for business
  facts.
- Node/diagnostic compatibility is not broken by this slice.
- Generated stubs now act as a regression surface: if a future build exposes the
  legacy types again, the greenfield gate fails.
- The internal profile/cache storage registries stay available to C++/Node while
  Python stops presenting old profile tables as a general public typed API.

## Alternatives Considered

- **Delete `AllDataTypes` immediately.** Rejected for this slice because Node
  raw frame decode, replay writer matching, and console dumps still depend on
  the full compiled schema set.
- **Expose profile/cache schemas because state cache still stores them.**
  Rejected for Python public API. The profile/cache closed sets are internal
  runtime storage details unless a future ADR defines a neutral public config
  surface.
- **Leave the benchmark in typed mode.** Rejected because test utilities shape
  developer expectations; keeping `Quote` there would preserve the exact API we
  are retiring.
