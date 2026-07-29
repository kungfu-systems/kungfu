# Deprecation lifecycle

Kungfu governs removals through one source registry:

- lifecycle contract:
  [`framework/deprecation/deprecation-lifecycle.contract.json`](../../framework/deprecation/deprecation-lifecycle.contract.json);
- current and historical entries:
  [`framework/deprecation/deprecation-registry.json`](../../framework/deprecation/deprecation-registry.json); and
- governing decision:
  [KF-ADR-019fad41-07fe-7f1e-a37a-a2572357700c](../adr/KF-ADR-019fad41-07fe-7f1e-a37a-a2572357700c.md).

Subsystem registries may contribute an entry or evidence, but they do not own a
separate due date, release exception, or settlement rule.

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

## Surface defaults

An entry may declare a longer window than its class default. It may not use a
shorter class to weaken a stable promise.

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

1. Classify the real surface and owner; do not classify by the desired removal
   speed.
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

## Current inventory

The registry distinguishes live debt from retained history:

- `core.yijinjing.boolean-mmap-adapters` remains deprecated and not due before
  its combined calendar and qualified-release window;
- `cli.prestable-compatibility-aliases` is settled: current alias references are
  zero, while its migration and removal evidence remain queryable.

When another local ledger is migrated, replace its lifecycle authority with a
pointer or contribution identity rather than copying the common fields back
into the subsystem.
