# Work Events Schema Ownership Migration Plan

This plan describes a future owner move for `work_events.fbs`. It does not
perform that move. The current declaration and compiled schema remain:

```text
framework/core/src/python/kungfu/work/work_events.fbs
framework/core/src/python/kungfu/work/work_events.bfbs
```

and `framework/core/schema-authority.json` continues to register those exact
paths as `kungfu.work.events`.

## Destination

The intended destination is an Agent Work native Domain Profile, with a
schema location such as `framework/work-loop/schema/work_events.fbs` owned by
the future L5 native admission Assignment. The exact path is not authoritative
until that Assignment admits it.

## Required gates

The owner move must be a separate reviewed change that proves all of the
following before changing `schema-authority.json`:

1. Source `.fbs` bytes and compiled `.bfbs` bytes are exactly identical before
   and after the move.
2. Existing Python and native readers replay the same golden journal corpus.
3. Every Root and receipt derived from the corpus remains byte-for-byte equal.
4. The new native service and versioned C ABI pass the reusable admission
   harness shared by the Initiative/Assignment L3 admission card group.
5. Legacy import paths remain readable for the declared compatibility window,
   with no dual writer and no ambiguous schema owner.
6. The schema-authority path changes atomically with the destination owner and
   all source checks pass.

## Forbidden shortcuts

The migration may not rewrite a journal, recalculate a Root, alias a legacy
identity to a new identity, treat generated bindings as authority, or copy
historical bytes into a new persistence plane. If exact parity cannot be
proved, the current owner remains in place and the admission fails closed.
