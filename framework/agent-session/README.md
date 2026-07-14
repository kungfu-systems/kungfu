# AgentSessionCapsule host, peer transport, and interaction port

`@kungfu-tech/agent-session` contains the process-lifetime boundary that owns
one provider PTY for one `SessionAttempt`. It directly spawns an absolute
executable plus argv; it never launches a persistent interactive shell.

The host stage provides:

- an injectable Capsule host with exact attempt, generation, stream-epoch and
  process-start fencing;
- a standalone local worker whose lifetime is independent of an Electron
  renderer or window;
- monotonic byte sequences, bounded replay, explicit overflow gaps and a
  printable text-grid VT snapshot;
- idempotent input delivery receipts and lifecycle receipts that never claim a
  semantic outcome or work completion;
- structured node-pty readiness diagnostics, including the known Darwin
  `spawn-helper` executable-mode failure; and
- a synthetic PTY provider covering ANSI, alternate-screen, raw input, an
  approval prompt, burst output and provider exit.

The worker's newline-JSON POSIX local socket is a Stage 2 test port, not the
public interaction transport.

The Stage 3 transport state machine adds:

- an injectable append-only journal + payload-free notice port shaped for the
  ADR-0077 mmap journal and nng wakeup planes;
- one Capsule output writer with independent cursors for every attachment;
- one generation-fenced controller lease, explicit takeover policy, input
  deduplication and expected-provider fencing;
- Coordinator re-registration without a stream-epoch reset and Supervisor
  adoption only with exact runtime/generation/process identity evidence; and
- bounded journal recovery, explicit gaps, VT snapshots, resize coalescing and
  a structural no-per-reader-fanout benchmark.

`InMemoryJournalNoticePort` is deterministic qualification infrastructure, not
a production broker. `NativeKungfuJournalNoticePort` binds the same authority
state machine to a native Watcher Peer: one public mmap journal writer carries
`kungfu.action-envelope/v1` frames and the writer's existing nng publication is
the payload-free wakeup plane. The Coordinator never proxies frame bytes and
the Capsule worker's local test socket is not a public relay.

The Stage 4 provider-neutral Interaction Port adds:

- `status`, `snapshot`, `instruct`, `sendKey`, and `interrupt` over the same
  generation-, epoch-, controller-, and foreground-fenced transport;
- deterministic `when-ready`, bounded `queue`, and interrupt-then-wait policy;
- versioned Codex `0.144.x` and Claude Code `2.1.x` redacted TUI signatures for
  `ready`, `busy`, `approval-needed`, `ended`, and `unknown`;
- one atomic bracketed-paste instruction plus one Enter, with duplicate input
  and trailing-Enter rejection; and
- visible adapter drift and opaque-shell fallback to explicit raw human input.

An automatic instruction is never delivered or queued from
`approval-needed` or `unknown`. `sendKey` is manual-only. Delivery receipts do
not contain instruction text and never claim provider understanding, semantic
outcome, work state, approval result, or interrupt result. Adapter fixtures are
synthetic and redacted.

The Stage 5 product surface adds:

- one self-describing `invoke` action shared by Electron IPC, the local
  runtime-scoped Unix socket, Python CLI/KFD-3, KFX, and product views;
- plan roots for start and control, exact foreground/epoch fencing, and
  delivery receipts that still cannot claim work state or proof;
- one-click WorkRef-bound Go launch with automatic side-console attachment,
  plus Assistant Console and Console Hub projections of the same Capsule; and
- presentation detach without provider termination, with no renderer-private
  spawn or PTY write path.

The Stage 6 recovery adapter moves Capsule ownership into one runtime-scoped,
detached product worker. Electron main, CLI, and KFD-3 reconnect through a
stable local endpoint; a worker loss starts an empty runtime and never presents
an old `SessionAttempt` as continuous. POSIX sockets use a short, per-UID 0700
directory so long macOS runtime paths cannot exceed the Unix socket limit.

The Stage 7 WorkConsole registry moves identity and lifecycle authority out of
the Terminal KFX and into that detached Core worker. `resolve-console`, `list`,
`show`, plans and metadata-only receipts now share one durable registry across
GUI, CLI and KFD-3. A generic WorkRef has one primary WorkConsole and each
provider restart/resume has a distinct SessionAttempt. Worker loss preserves
the record but marks the old Capsule attempt `unrecoverable`; it never invents
process continuity. Terminal panes, splits, drawers and windows retain only
stable identity references and are not part of the portable registry.

The retained Mac source qualification proves main-process reconnect, provider
exit fencing, worker-loss fail-closed behavior, bounded overflow gaps, receipt
privacy, and sub-millisecond local RPC p95. Authenticated Codex 0.144.3 passes
start, instruction/output, approval detection plus deny-key delivery,
interrupt, reconnect, and end. Claude Code 2.1.209 passes start, temporary
workspace trust, instruction/output, and reconnect, but its real tool-approval
state did not converge to a supported signature; promotion remains blocked by
that explicit degraded result. Raw terminal bytes and environment values are
never written to the retained report.

Run the focused qualification through Shifu:

```sh
./shifu test:agent-session-capsule-host
./shifu test:agent-session-peer-transport
./shifu build:core
./shifu test:agent-session-peer-transport:native
./shifu test:agent-session-interaction-adapters
./shifu test:agent-session-interaction-adapters:native
./shifu test:agent-session-product-surfaces
./shifu test:agent-session-recovery-qualification
./shifu test:agent-console-contract
./shifu --filter @kungfu-tech/gui build
```

The build-free source gate runs the pure host and transport tests only. Native
qualification is separate: after `build:core`, it starts a real Coordinator and
two cross-process Watcher Peers, then proves public-journal replay, nng wakeup,
cursor reconstruction and absence of a Coordinator byte proxy. The Capsule host
focused command also runs the native node-pty worker smoke; native checks stay
outside the source-only lifecycle because that runner installs dependencies
without native build scripts.

The interaction adapter native command is build-free and local-only: it checks
installed Codex and Claude Code version output under a temporary HOME without
reading provider auth, private transcripts, or hidden session databases. Real
authenticated instruction, approval/deny, and provider-outcome dogfood runs
through the opt-in `qualify:agent-session-provider` command with explicit
temporary runtime/workspace paths. The command emits metadata-only JSON and
fails closed on unknown provider screens.

The Codex App Server structured-hybrid contract is a separate provider adapter
stage under ADR-0085. It pins direct stdio, Codex CLI `0.144.3`, the generated
non-experimental stable schema bundle, admitted methods, provider identity, raw
retention, and recovery limits without changing the shared Interaction Port or
Claude/PTTY authority. Its committed 267-file manifest defines an independently
recomputable bundle digest; unknown versions, capabilities, methods, required
fields, or schema bytes fail closed.

Run the credential-free contract and installed-schema drift gates through
Shifu:

```sh
./shifu test:codex-app-server-contract
./shifu test:codex-app-server-contract:native
```

The native gate generates stable schema under a temporary `HOME` and
`CODEX_HOME`; it does not inspect provider auth or session state. Normalization,
recovery guards, product routing, and real authenticated dogfood belong to later
ADR-0085 implementation stages.

The Stage 2 direct-stdio runtime host adds a single continuously draining JSONL
reader, exact request/server-request correlation, attempt/generation/process
fencing, metadata-only stderr observation, and a bounded in-memory consumer
queue. Reaching the admission threshold permanently freezes new writes for that
attempt; crossing the hard bound fails visibly and terminates the provider.
Runtime loss never replays input or claims a provider outcome. The synthetic
provider smoke reads no credentials or private provider state:

```sh
./shifu test:codex-app-server-runtime
```

The Stage 3 structured interaction adapter consumes only the fenced runtime
event stream. It emits deterministic provider-private plans and typed receipts
for thread, turn, item, tool, approval, usage, error, and lifecycle traffic.
Provider request, thread, turn, and item identities remain exact; approvals and
other server controls default to deny; stale targets, event gaps, repeated turn
terminals, and mutated plans fail closed. Request admission and control delivery
never claim semantic work outcome, Profile/KFD work state, or proof:

```sh
./shifu test:codex-app-server-interaction
```

The Stage 4 recovery guard writes provider-private, prompt-free admission
metadata to an injected durable journal before any provider request or control
response. Exact input and side-effect ids deduplicate completed receipts; an
opened or unknown receipt forbids blind replay. Runtime loss first marks
unresolved admissions and controls unknown, then closes the old attempt.
`thread/read` is observation rather than replay, `thread/resume` requires an
exact old boundary and a new attempt, and PTY fallback can only plan another
new attempt while preserving the old structured receipts. Journal gaps,
receipt-root drift, queue admission freeze, and process-fence drift fail closed:

```sh
./shifu test:codex-app-server-recovery
```

The adapter owns no second database: product integration must inject the
existing Agent Session journal authority behind this append/read seam. The
Stage 4 source test uses only a deterministic in-memory journal and synthetic
runtime; it does not read provider credentials or private session state.

The Stage 5 product adapter routes Codex `0.144.3` through direct stdio only
when `KUNGFU_AGENT_SESSION_CODEX_APP_SERVER=1`. With the flag absent, Codex and
Claude retain the existing PTY plan, capabilities, authority, and receipt
shape. GUI, CLI, and KFD-3 use the same product `invoke` seam for structured
start, instruction, interrupt, exact provider control response, status, and
receipts; no presentation owns a private provider mutation path.

The route is frozen for one `SessionAttempt`. Runtime loss or explicit end
closes the structured attempt at an `unknown` or `interrupted` boundary. PTY
fallback must preserve the same WorkConsole, create a distinct attempt, and
retain the old structured receipts; hot switching the live attempt is
forbidden. Product status projects provider thread/turn identity and pending
controls, but receipts still claim neither semantic outcome, work state, nor
proof. The source-only product qualification uses a synthetic provider and
reads no provider credentials or private state:

```sh
./shifu test:codex-app-server-product
```

On Darwin, packaged products must restore the executable bit on node-pty's
`spawn-helper`. The existing Electron `afterPack` audit already owns that
repair. The Mac smoke copies node-pty into a temporary harness directory and
repairs only that disposable copy, so verification never mutates the checkout's
installed dependency tree.
