# ADR-0064: runtime libraries propagate structured errors; loop owners decide how execution stops

- Status: proposed
- Date: 2026-07-12
- Category: (b) correctness + embedding boundary
- Subsystem: replay writer, Rx subscription errors, reactor/peer loop ownership, Python and Node hosts
- Related: [ADR-0003](ADR-0003-control-axis-python-coroutine-integration.md),
  [ADR-0004](ADR-0004-control-axis-node-watcher-snapshot-model.md),
  [ADR-0005](ADR-0005-control-event-axis-modernization-assessment.md),
  [ADR-0020](ADR-0020-agent-action-timeline-and-replay-boundary.md),
  [ADR-0063](ADR-0063-yijinjing-concurrency-and-lifetime-contract.md)

## Context

Two library-level error paths can currently interrupt an entire process:

- `replay_writer::open_frame()` calls `raise(SIGINT)` when it cannot find more
  replay data for a carrier type, then continues constructing a cloned frame if
  a signal handler returns.
- The default Rx `loop_interrupter()` also calls `raise(SIGINT)`. A reactor
  replaces it with a callback that calls `signal_stop()`, but the callback is a
  mutable process-wide static `std::function` that captures one reactor. Multiple
  reactors can overwrite one another, and destruction does not establish an
  explicit lifetime boundary for the captured object.

A library cannot know whether its host is a CLI, Python interpreter, Node
process, desktop application, test runner, embedded runtime, or another service.
Sending a process signal from the middle of replay or subscription dispatch
bypasses that host's error, cleanup, and policy boundaries.

ADR-0005 froze the v4 Rx routing algebra, synchronous fan-out model, and
performance work because measurement showed no bottleneck. This proposal does
not reopen that decision. Error ownership and callback lifetime are correctness
boundaries around the loop, not a replacement or optimization of Rx routing.

## Proposed decision

### 1. Libraries report errors; application boundaries choose process behavior

Code below the CLI/application host does not raise `SIGINT`, call `exit`, or
otherwise terminate the process as an error-reporting mechanism.

- Synchronous library operations return a typed result or throw a documented
  typed exception.
- Asynchronous loop/subscription errors are delivered to an owner-provided error
  sink associated with that loop instance.
- Only a top-level CLI or explicit process supervisor may convert an error or
  user interrupt into a process signal or exit code.

### 2. Replay exhaustion is a typed outcome

Reaching the end of replay or failing to find the requested carrier is reported
as `replay_exhausted` (or an equivalent typed `replay_error` result). It does not
manufacture a writable frame after signalling an error.

The caller decides whether exhaustion means normal EOF, a failed deterministic
replay contract, or a request to stop the owning runtime. Python and Node map
the outcome to their ordinary exception/EOF mechanisms; a CLI may map it to a
documented non-zero exit status.

### 3. Every event loop owns its stop and error state

Each reactor/loop instance owns an error state containing at least:

- the first `std::exception_ptr` (or typed error);
- an idempotent stop request;
- a lifetime-safe callback/token used by subscriptions;
- a way for the host boundary to inspect, return, or rethrow the error after the
  pump unwinds.

Subscription error handling records the first error and requests that same
loop to stop. It does not mutate a process-global callback, target another
reactor, or retain an unscoped raw `this` capture.

The owner may implement the stop request with `std::stop_source`, a weakly owned
loop state, or an equivalent explicit token. The semantic requirement is
per-loop identity and lifetime, not a specific C++ class.

### 4. Unwinding and host translation happen at a stable boundary

The pump completes its current failure path, releases subscriptions/resources,
and returns control to its owner. The owner then translates the recorded error:

- C++ run loop: return a typed status or rethrow at the documented `run`/`step`
  boundary;
- Python: raise through the binding/coroutine boundary with the original cause;
- Node: reject/report through the watcher/event-loop boundary;
- GUI/service: report failure and apply its own restart/stop policy;
- CLI: render a diagnostic and choose an exit code.

User-originated `SIGINT` remains a valid top-level control input. This ADR only
forbids a library from synthesizing it as an internal error channel.

### 5. Preserve the frozen Rx execution model

No routing operator, filter-chain declaration, `holdon` step primitive,
synchronous fan-out rule, or dispatch indexing changes under this ADR. The
change is limited to error-sink injection, stop ownership, lifetime cleanup, and
host propagation.

Performance optimization of the reactive layer remains governed by ADR-0005's
measured reopening conditions.

## Compatibility and migration

1. Introduce typed replay errors and migrate in-tree replay callers/bindings.
2. Add a per-loop error/stop owner and inject it into subscription construction.
3. Keep a temporary compatibility adapter for Rx use outside a reactor, but its
   default records/throws a structured error; it never raises a process signal.
4. Remove the process-global mutable interrupter after repository-wide caller
   migration.
5. Update public contracts and known limits so "loop stopped" and "process
   interrupted" are never used as synonyms.

No journal layout, frame publication, replay data, or routing declaration
changes.

## Alternatives considered

- **Keep `raise(SIGINT)` for fail-loud behavior.** Rejected: it is loud at the
  wrong ownership layer and can terminate unrelated embedded work.
- **Install a signal handler in every host.** Rejected: handlers are
  process-global, platform-sensitive, and still lose loop identity and the
  original exception.
- **Retain one global callback but guard it with a mutex.** Rejected: a mutex
  prevents data races but cannot make one callback belong to multiple reactors
  or solve captured-object lifetime.
- **Swallow subscriber errors and continue.** Rejected: routing chains are
  load-bearing; a silently dead chain is worse than a cleanly stopped loop with
  a preserved cause.
- **Replace RxCpp while touching error handling.** Rejected by scope and by
  ADR-0005's measured freeze decision.

## Acceptance and verification gates

Before this ADR can become accepted/implemented:

1. Replay exhaustion tests prove no signal is emitted and no synthetic frame is
   returned after exhaustion.
2. Subscriber exceptions preserve type/message/cause through C++, Python, and
   Node owner boundaries.
3. Two reactors running concurrently receive only their own errors and stop
   independently.
4. Destroying a reactor/host before or after subscription teardown leaves no
   callback capable of dereferencing it.
5. Repeated errors record the first cause and request stop idempotently.
6. Existing explicit user `SIGINT` handling and CLI exit-code tests remain
   intact.
7. The ADR-0005 dispatch benchmark shows no material regression; routing and
   step-mode qualification remain unchanged.

## Consequences

- Embedding hosts regain authority over cleanup, diagnostics, restart, and
  process lifetime.
- Errors retain their original cause instead of being flattened into SIGINT.
- Per-loop state removes cross-reactor callback interference and dangling
  captures.
- The implementation touches a load-bearing boundary and therefore requires
  multi-host qualification even though it deliberately leaves Rx routing
  unchanged.
