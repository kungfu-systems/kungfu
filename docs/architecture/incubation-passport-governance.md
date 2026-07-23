# Incubation Passport Governance

An incubation passport records where an object is allowed to live now and who
must own it after admission. It makes that decision at object birth, before a
temporary script, schema location, or runtime store becomes accidental
authority.

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
