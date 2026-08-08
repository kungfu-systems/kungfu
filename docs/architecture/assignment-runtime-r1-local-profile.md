# Assignment Runtime R1 Local Profile

R1 adds one production embedded implementation of
`kungfu.assignment-runtime/v1`. `EmbeddedLocalAssignmentRuntime` owns the
single-writer boundary, durable idempotency metadata, rooted event cursors,
crash recovery, and stable public errors. `WorkControlAuthority` remains the
only Assignment transition authority and invokes the existing active
`kungfu.work-control` Profile; the Runtime does not append domain Facts or
interpret the Work Control storage layout.

`EmbeddedAssignmentRuntimeClient` is the typed in-process client surface. It
constructs the same versioned JSON request envelopes that a later transport
would carry and returns the unmodified response envelope. R1 does not migrate
any GUI, CLI, Agent, or KFX production caller to that client.

## Runtime boundary

- Discovery reports `embedded` supported, `loopback` unavailable, and
  `cluster` out of scope, plus the exact contract capabilities and
  compatibility bounds.
- One realm generation admits one Runtime writer. Startup uses a non-blocking
  same-host named lock and rejects a second writer instead of waiting.
- Calls within the embedded writer are serialized. CAS revision, generation,
  command identity, idempotency key, attempt, active unexpired lease, and
  Warrant scope are checked before authority mutation.
- Runtime metadata is private implementation state below the selected runtime
  root. Public envelopes contain only logical identities, canonical roots,
  receipts, references, cursors, diagnostics, and stable errors.
- Interrupted commands are replayed only when the authority cut proves the
  mutation did not happen, or finalized from an already durable authority
  result. An uncertain authority change becomes an explicit manual-recovery
  diagnostic.

## Compatibility and non-claims

The R0 contract and its fixtures remain byte-identical. Current Mission
Control, Atlas gate, and captured-request readers remain explicit read-only
compatibility inputs. Existing Profile, GUI, CLI, Agent, and KFX writers are
not declared Runtime clients and are not removed in R1. Dual write remains
forbidden.

R1 does not provide a loopback listener, authenticated remote transport,
PostgreSQL authority, scheduler, multi-host recovery, HA, sharding, capacity
qualification, or Cluster Runtime. Those absences are capability bounds, not
fallback triggers.

## Qualification

`./shifu test:assignment-runtime` runs the immutable R0 contract suite plus
disposable-Home Python tests for discovery, root parity, typed-client envelopes,
CAS, concurrent duplicate submission, command identity, idempotency, attempt,
lease and Warrant fencing, second-writer rejection, non-blocking lock
contention, authority bypass, reconnect, event gaps, crashes, interrupted
writes, diagnostics, and recovery. The production adapter test uses the built
native binding when it is present; binding-less source checks report that case
as skipped rather than simulating native authority.

Qualification must never select or mutate the user's real `~/.kungfu`.
