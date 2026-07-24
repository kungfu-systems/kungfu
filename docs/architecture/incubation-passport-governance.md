# Incubation Passport Governance

An incubation passport records where an object is allowed to live now and who
must own it after admission. It makes that decision at object birth, before a
temporary script, schema location, or runtime store becomes accidental
authority. The governing decision is
[KF-ADR-019f8fb8](../adr/KF-ADR-019f8fb8-579b-78d5-9ebb-da03bb9aa40c.md).

The executable contract is
[`incubation-passport.contract.json`](../../framework/incubation/incubation-passport.contract.json).
Its versioned registry, schemas, exact known-issue baseline, checker, and golden
negative cases are adjacent to the contract or under `tests/fixtures`.

## Passport decision

Every passport declares:

- a current `runtime` or `git` anchor;
- its destined layer, owner, and future admission Assignment;
- one structured-fact schema owner, when structured facts persist;
- who owns persistent bytes and what scripts may do;
- whether the object mints a Root or other identity preimage; and
- an admission trigger and, for bounded runtime incubation, a deadline.

A passport may also declare one or more primitives. These declarations are the
sole intake to the derived Primitive Catalog described by
[KF-ADR-019f917f-d116-70e8-b4a1-2e0209598aec](../adr/KF-ADR-019f917f-d116-70e8-b4a1-2e0209598aec.md). They point
to existing authorities and evidence; they do not copy or supersede them.

`framework/core/schema-authority.json` remains the authority for Hana and
FlatBuffers schemas. A versioned Domain Profile contract world may own its own
fact-surface definitions, but that does not make JSON a second journal or
storage authority.

## Hard boundaries

Runtime-anchored persistent facts use the native journal. Python, TypeScript,
and other scripts may own orchestration, validation, folds, and projections;
they do not own durable bytes or identity.

Any passport that mints Roots requires two independent implementation
languages and committed golden vectors before admission. A single
implementation can remain visible in incubation only through an exact,
owned, expiring baseline entry.

Registration is additive. It never moves, rewrites, recalculates, or aliases
sealed evidence. A later owner move must preserve exact schema and protocol
bytes, keep historical readers, and pass its own admission gate.

## Gate behavior

Run:

```text
node scripts/check-incubation-passport.mjs
node --test scripts/check-incubation-passport.test.mjs
node scripts/generate-primitive-catalog.mjs --check
```

The checker scans every tracked `.fbs` and `.bfbs`, resolves registered schema
owners, validates all referenced paths, checks Root protocol conformance, and
rejects overdue runtime incubation. The baseline is an exact set: a new issue,
an expired waiver, or a stale entry all fail. This keeps current debt visible
without granting an open-ended exception to future files.

## Current boundary

The initial registry records the admitted KFR2 reference protocol, the
incubating Work journal, the registered Atlas/Rewind/Work event schemas, and
the Initiative/Assignment L3 Domain Profile. Existing bytes, Roots, journal
coordinates, and sealed evidence remain unchanged.
