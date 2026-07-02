# ADR-0011: v4 capability SDK contract — first cut

- Status: proposed (contract ratified 2026-07-02; implementation pending). The
  shape below is grounded in the reference GUI, the reference TUI, and the two
  built-in default extensions, which already exercise it internally.
- Date: 2026-07-02
- Category: (architecture) contract — the capability face of the v4 platform
- Subsystem: frontend/SDK — `framework/api` (capability SDK), consumed by the
  reference surfaces (ADR-0006, ADR-0007) and extensions
- Related: ADR-0006 defined the platform model (capability SDK + loose kfx
  contract + minimal reference surfaces); ADR-0007 added the terminal surface.
  This ADR pins the first cut of the capability contract both left open.

## Decision

1. **Two vocabulary domains, one SDK.** The capability face speaks two
   deliberately distinct vocabularies:
   - a **ledger domain** for runtime event data — open a ledger, iterate
     ordered records with their causal parents, subscribe to live updates,
     obtain replay anchors;
   - a **domain vocabulary** for domain state (positions, orders, quotes)
     consumed by domain-specific surfaces.
   Neither domain may leak storage-engine terms (pages, frames, memory
   mapping) into the public surface. Unifying everything under ledger
   vocabulary was rejected: domain surfaces would be translated awkwardly for
   no consumer benefit.

2. **Extensions declare their runtime tier.** An extension manifest carries
   `runtime: 'node-integrated' | 'sandboxed-ipc'`. The node-integrated tier
   grants in-process zero-copy access to runtime data and requires the host's
   node-integrated context (ADR-0006); the sandboxed tier is reserved for
   untrusted or remote UI and only ever sees serialized data. The two tiers
   never share a rendering context. The field is a declaration, not a runtime
   probe — hosts place extensions by manifest, and violations fail loudly.

3. **One package, an internal boundary.** The capability SDK stays inside
   `@kungfu-tech/api` as a `capability/` module with factory-style entry
   points and no import-time side effects. The existing singleton exports
   remain during the transition and retire consumer by consumer. A separate
   SDK package is deferred until a second real external consumer exists —
   a published package is a permanent API maintenance surface and is not
   created on speculation.

4. **Five handles, consumer-driven.** The first cut of the capability surface
   is exactly what the reference surfaces and default extensions consume:
   `openLedger(locator)`, `records(stream, range)`, `subscribe(filter)`,
   `replayAnchors(run)`, and `domainState()`. Contract details forced by
   practice: the locator must express the home/runtime directory layering;
   64-bit identifiers cross the boundary as BigInt with a defined
   serialization rule; enum-to-name mapping for shared types lives in the SDK,
   not in each consumer; and live-bus health (for example a socket that failed
   to bind) is a first-class queryable signal, not a log line.

## Explicitly out of scope

- A general query language over the ledger.
- A write API on the UI capability face — producers embed through the
  runtime's own write paths, never through a UI SDK.
- Schema-registry mechanics: the SDK passes schema identifiers through and
  adopts the registry when that work lands (see the schema-registry slice).

## Alternatives considered

- **Ledger-only vocabulary** — rejected (see decision 1).
- **Design the full SDK surface up front** — rejected; ADR-0006's discipline
  stands: the surface grows from real consumers, and the five handles are the
  set that real surfaces demanded.
- **Split package now** — rejected as premature; revisit at the second
  external consumer.

## Next (implementation)

1. Stand up `capability/` in `framework/api` with the five handles typed and
   implemented over the existing binding.
2. Migrate the built-in default extensions and the reference surfaces onto it;
   retire the singleton exports as consumers move.
3. Ratify this ADR to accepted once the reference surfaces consume the module.
