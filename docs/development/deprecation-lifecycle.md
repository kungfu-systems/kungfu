# Deprecation lifecycle

Kungfu governs removals through one source registry:

- lifecycle contract:
  [`developer/deprecation/deprecation-lifecycle.contract.json`](../../developer/deprecation/deprecation-lifecycle.contract.json);
- discovery contract:
  [`developer/deprecation/deprecation-discovery.contract.json`](../../developer/deprecation/deprecation-discovery.contract.json);
- current and historical entries:
  [`developer/deprecation/deprecation-registry.json`](../../developer/deprecation/deprecation-registry.json); and
- governing decision:
  [KF-ADR-019fad41-07fe-7f1e-a37a-a2572357700c](../adr/KF-ADR-019fad41-07fe-7f1e-a37a-a2572357700c.md).

Subsystem registries may contribute an entry or evidence, but they do not own a
separate due date, release exception, or settlement rule.

Discovery and lifecycle answer different questions. Discovery establishes that
every machine-recognizable live marker has exactly one stable registry
identity. The lifecycle contract alone decides due dates, removal
qualification, settlement, and Warrant handling. A green discovery result is
never permission to remove a surface.

## Surface enrollment

The versioned discovery contract recognizes:

- C++ `[[deprecated]]` attributes;
- Python `DeprecationWarning`;
- JavaScript and TypeScript JSDoc `@deprecated`;
- FlatBuffers and Protocol Buffer deprecation attributes;
- structured CLI aliases, KFX deprecation records, and release artifact
  deprecation records;
- document frontmatter with `document_status: deprecated`.

Text markers carry one token in their machine-recognizable declaration:

```text
kungfu-deprecation:<entry-id>#<marker-id>
```

Structured records carry the same coordinates as `deprecationEntry` and
`deprecationMarker`. Documents use `deprecation_entry` and
`deprecation_marker` frontmatter. The matching registry entry declares the
marker id, dialect, and exact current path under `surface.markers`.

Adding the marker and its registry declaration is one reviewable change.
Orphans, unknown entries, duplicate marker identities, path or dialect
mismatches, missing declared surfaces, and live entries without a marker fail
closed.

Generated and historical classifications are not free-form ignore lists.
They must use a supported dialect, one exact file or a narrow generated
subtree, and a reviewable reason in the discovery contract. Unknown dialects
and broad prefixes are invalid.

## Lifecycle and release dispositions

Entries author `active`, `deprecated`, `removed`, or `settled`.
`removal-due` is computed by the audit and must not be written into the
registry.

The release projection gives every entry one disposition:

| Disposition | Meaning |
|---|---|
| `not-due` | The first eligible removal release has not arrived, or support was explicitly restored. |
| `due` | The candidate is eligible for removal and needs qualified removal, restored support, or one exact Warrant. |
| `removed` | Removal and migration evidence are present; `settled` entries retain history without executable debt. |
| `extended-by-warrant` | One exact native Warrant projection covers this candidate and date. |
| `invalid` | Authority, version, history, evidence, or release context is ambiguous; release decisions fail closed. |

## Surface defaults and classification integrity

The values below are executable lower bounds, not suggested defaults. An entry
may declare a longer calendar or qualified-release window, and the projection
preserves those stricter values. A smaller value fails with
`deprecation-window-below-minimum`.

| Surface class | Minimum days | Qualified releases | Earliest breaking boundary |
|---|---:|---:|---|
| Internal or experimental | 0 | 0 | Any qualified release |
| Public alpha or preview | 30 | 1 | A later pre-stable release, or a later major |
| Stable CLI, SDK, or public API | 90 | 1 | Next major |
| KFX contribution | 90 | 1 | Next major |
| Document | 30 | 1 | Any qualified release |
| Artifact | 90 | 1 | Next major |
| Persisted schema or wire protocol | 180 | 2 | Next major plus a qualified historical reader, export, or migration |

A same-minor stable release does not gain breaking permission from elapsed
time. A pre-stable cleanup does not create a stable compatibility promise, but
it still follows any public alpha window already declared.

Every entry also carries a `classification` projection. Core source surfaces
bind an exact rule in `framework/core/architecture/layers.json`; CLI surfaces
bind the CLI surface registry; other governed kinds bind the deterministic kind
policy in the lifecycle contract. The validator resolves that authority and
checks the current path, rule, maturity, or kind before accepting the selected
class. It also cross-checks every live marker dialect, so changing both the
authored kind and class cannot relabel a structured CLI, KFX, artifact,
document, schema, or protocol marker. Stable CLI, SDK, and public API promises
cannot become preview; KFX, artifact, document, persisted-schema, and
wire-protocol kinds cannot be substituted for one another to obtain a faster
window.

Dates are evaluated against the audit or candidate release date. Entry and
settlement versions may not be later than the registry's authoritative product
version. Persisted schema and protocol support claims additionally name an
exact authority file and non-empty qualification evidence; a boolean claim
alone is invalid.

## “Next eligible release”

The next eligible release is the first qualified release for which all of the
following are true:

1. its date is on or after the deprecation date plus the calendar window;
2. the qualified-release count after deprecation reaches the declared minimum,
   including the candidate; and
3. its version crosses the surface class's allowed removal boundary.

For a persisted schema or protocol, the historical reader, export, or migration
must also be qualified. If release history or support evidence is unknown, the
audit reports `invalid`; it does not guess.

## Warrant boundary

An extension is a projection of native `kungfu.warrant` authority, not a second
waiver system. It binds an exact Warrant Root, entry id, authorizer, issue date,
calendar expiry, last covered release, and retained evidence reference.

The projection is bounded to at most 90 calendar days by the current contract.
It is non-renewing by default. `renewalOf` and implicit rollover are invalid.
At expiry the owner must qualify removal, restore support with evidence, or stop
the protected release.

## Adding or settling an entry

1. Classify the real surface and owner; bind the exact existing authority or
   deterministic kind rule, and do not classify by the desired removal speed.
2. Record the current path and symbols, replacement, migration guide,
   deprecation date/version, known consumers, windows, boundary, conditions,
   retained evidence, and executable zero-reference checks.
3. Keep the entry `deprecated` until the release boundary and all removal
   evidence are satisfied.
4. When removing, record the exact commit, release note, migration
   qualification, retained evidence, and a current-head zero-reference audit.
5. Move to `settled` only when executable debt is gone. Never delete the
   historical entry to make the audit green.

Restoring a surface uses `active` plus an explicit restoration decision and
qualification evidence. It is not an unrecorded reset of the clock.

The settled `cli.prestable-compatibility-aliases` entry preserves one historical
pre-stable 0/0 migration fact. This is not a general exception. Its grandfather
record is contract-reserved to that exact entry id and matches the settled
lifecycle, surface, class, deprecation coordinates, windows, boundary, removal
coordinates, commit, and evidence. Copying it, renaming it, or changing any
bound value makes both the grandfather and the below-minimum windows invalid.

## Read-only audit

Inspect current debt without changing repository or runtime state:

```sh
./shifu deprecation:audit -- --as-of 2026-07-29 --json
```

Evaluate a protected candidate:

```sh
./shifu deprecation:audit -- \
  --release 4.0.0-alpha.2 \
  --release-date 2026-08-12 \
  --channel alpha \
  --strict-due \
  --json
```

Run the focused contract and release-gate regression:

```sh
./shifu check:deprecation-lifecycle
./shifu adr:release:gate -- --contract-only
./shifu release:promotion:rehearse
```

The JSON report is a read-only projection. It carries the contract and registry
Roots, release context, per-entry next action, blockers, and findings; it does
not mutate lifecycle state or mint evidence.

Source acceptance evaluates both scopes:

- the full-tree audit catches retained drift and is the periodic baseline;
- the changed-file audit examines every added or modified source path, so a
  pull request cannot introduce a marker merely by leaving the registry
  untouched.

## Current inventory

The registry distinguishes live debt from retained history:

- `core.yijinjing.boolean-mmap-adapters` remains deprecated and not due before
  its combined calendar and qualified-release window;
- `core.yijinjing.journal-open-policy-adapters` and
  `core.yijinjing.page-open-policy-adapters` retain the observed 2026-07-11
  introduction dates and enroll the four remaining C++ markers;
- `cli.prestable-compatibility-aliases` is settled: current alias references are
  zero, while its exact non-copyable historical grandfather, migration, and
  removal evidence remain queryable.

The current full-tree inventory contains nine live C++ markers, three live
registry entries, one settled entry, and one explicitly classified historical
document. Generated vocabulary is reported separately when present.

When another local ledger is migrated, replace its lifecycle authority with a
pointer or contribution identity rather than copying the common fields back
into the subsystem.
