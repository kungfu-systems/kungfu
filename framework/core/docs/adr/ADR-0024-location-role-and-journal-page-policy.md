# ADR-0024: location role replaces trading category and journal page size is storage policy

- Status: accepted
- Date: 2026-07-08
- Category: (architecture) yijinjing location identity and storage policy
- Subsystem: yijinjing schema core schema, yijinjing locator, journal page sizing,
  Python and Node bindings, capability SDK.
- Related: ADR-0001 defines the journal publication barrier. ADR-0008 defines
  yijinjing schema compatibility surfaces. ADR-0018 defines runtime storage as a
  service. ADR-0022 defines the C++ core as the polyglot action-recording
  membrane.

## Context

The legacy trading runtime used `category` values such as `md`, `td`,
`strategy`, `operator`, and `system` in the location path:

```text
<layout>/<category>/<group>/<name>/<mode>
```

That vocabulary encoded trading product roles into the journal identity layer.
It also leaked into journal page sizing: market-data categories received large
mmap pages, trading categories received medium pages, and some public/sync paths
received small pages.

For v4 this is the wrong abstraction. Kungfu is being rebuilt as a runtime fact
ledger for agents, applications, extensions, and storage sync. No deployed v3
system is expected to run on v4 journals, so this decision intentionally starts
from the v4 design instead of preserving trading-era names.

## Decision

`category` is removed from the v4 location contract. The location identity is:

```text
role / group / name / mode
```

The core enum is `location_role`:

| Role | Path name | Meaning |
|---|---|---|
| `SOURCE` | `source` | A fact-producing endpoint. |
| `SINK` | `sink` | A fact-consuming or command-facing endpoint. |
| `ACTOR` | `actor` | An active runtime participant such as an agent or app. |
| `SYSTEM` | `system` | Kungfu-owned infrastructure endpoints. |
| `SERVICE` | `service` | Long-lived runtime service endpoints. |

The existing path shape remains stable as:

```text
<layout>/<role>/<group>/<name>/<mode>
```

The field name in `Location`, `Register`, `Session`, `Config`,
`RequestWriteToBand`, capability SDK location objects, Python bindings, and Node
bindings is `role`.

Journal page size is no longer derived from location role. The default page
size is a storage policy constant. Callers that need a different page size must
pass an explicit page size through the existing writer/request APIs.

The first v4 default is:

- explicit `page_size` wins;
- explicit sizes below 2 MiB are clamped to 2 MiB;
- default journal page size is 16 MiB.

## Consequences

- New code must not introduce `category` for yijinjing location identity.
- New code must not use role as a proxy for mmap/page capacity. Storage policy
  belongs to writer/request configuration or future runtime storage config.
- Python and Node are binding surfaces over the C++ enum and `Location` fields;
  they must not maintain independent role vocabularies.
- Fresh v4 runtime directories use `source`, `sink`, `actor`, `system`, and
  `service` path segments.
- Existing v3/trading-era journal directories are not a compatibility target for
  v4 greenfield startup.

## Alternatives considered

- **Keep `category` and only rename enum values.** Rejected. The old field name
  would keep inviting new v4 code to copy trading-era semantics.
- **Preserve old role names as aliases.** Rejected for the greenfield v4 start.
  Compatibility aliases would make old examples look valid.
- **Derive page size from role with new names.** Rejected. The root problem is
  coupling identity to capacity. A source can be tiny; a service can be large.
- **Move page size immediately into full config.** Deferred. The current writer
  APIs already accept explicit page size, and a constant default is a smaller
  first step. A config-backed storage profile can be added later without
  reintroducing role coupling.

## Residual risk

- Some higher-level runtime paths still carry trading-origin names such as
  broker or trading-data caches. Those are separate product-domain migrations.
  They may temporarily map old behavior onto neutral roles, but they must not
  reintroduce `category` as a storage identity.
- Existing docs or examples outside the compiled/runtime path may still mention
  the historical term. They should be cleaned when touched.
- Changing the field name is a breaking schema/API change. That is intentional
  for v4 before the first real user data baseline is created.
