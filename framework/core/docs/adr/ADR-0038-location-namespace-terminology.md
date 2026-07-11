# ADR-0038: location middle identity segment is namespace

- Status: accepted
- Date: 2026-07-09
- Category: (architecture) yijinjing location identity
- Subsystem: yijinjing schema, locator, Python and Node bindings, journal CLI,
  runtime storage manifests.
- Related: ADR-0024 replaces trading `category` with `role`. ADR-0033 defines
  Episode as a first-class causal segment object. ADR-0034 defines Episode
  manifests as yijinjing journal records.

## Context

ADR-0024 greenfielded v4 location identity away from trading categories and left
the path shape as:

```text
<layout>/<role>/<group>/<name>/<mode>
```

The middle segment was still called `group`. That name is too generic for the
new runtime-fact-ledger world: it does not explain whether the segment is a
team, package group, product group, storage family, or logical identity scope.
It also risks being copied into new Episode, storage, source-sync, and
polyglot-binding APIs.

The segment is not an enum. It is a caller-defined scope below `role` and above
`name`: for example `system/storage/episode-manifest/live` means role `system`,
namespace `storage`, name `episode-manifest`, mode `live`.

## Decision

The public location identity is:

```text
role / namespace / name / mode
```

The physical path shape remains:

```text
<layout>/<role>/<namespace>/<name>/<mode>
```

No path level is added or removed. Existing v4 path examples keep their segment
positions and reinterpret the middle segment as `namespace`.

Because `namespace` is a C++ keyword, C++ Hana structs and C++ APIs use the
member name `namespace_`. Serialization and binding layers expose the canonical
public name `namespace`:

- JSON output writes `namespace`.
- Python generated type bindings expose `.namespace`.
- Node generated type bindings expose `namespace`.
- Handwritten location objects expose `namespace`.

During the v4 greenfield transition, parsers may accept legacy `group` input for
the same field. Outputs must canonicalize to `namespace`; new docs, examples,
and manifests must not introduce new `group` fields for location identity.

## Consequences

- `Location`, `Register`, `Deregister`, `Config`, `OutputKey`, and
  `RequestWriteToBand` share the same `namespace` public field.
- Journal CLI filters use `--namespace`; `-g` may remain as a short alias and
  `--group` may remain hidden only as a temporary input compatibility shim.
- Episode manifest journals continue to live at:

```text
journal/system/storage/episode-manifest/live/*.journal
```

  with `storage` as the namespace.
- Future storage/source/sync APIs should use `namespace` whenever they refer to
  this location segment. Separate product or UI grouping concepts must not
  overload this field.
