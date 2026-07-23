---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0085
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/849, https://github.com/kungfu-systems/kungfu/pull/851, https://github.com/kungfu-systems/kungfu/pull/855, https://github.com/kungfu-systems/kungfu/pull/857, https://github.com/kungfu-systems/kungfu/pull/861]
qualification_refs: [framework/agent-session/tests/codex-app-server-contract.test.mjs, framework/agent-session/tests/codex-app-server-schema.native.test.mjs, framework/agent-session/tests/codex-app-server-runtime.test.mjs, framework/agent-session/tests/codex-app-server-interaction.test.mjs, framework/agent-session/tests/codex-app-server-recovery.test.mjs, framework/agent-session/tests/codex-app-server-product.test.mjs, framework/agent-session/schemas/codex-app-server/codex-v0.144.3-stable-schema-manifest.json, scripts/run-agent-session-provider-dogfood.mjs]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-07-14
theme: codex-app-server-structured-hybrid-adapter
confidence: high
evidence_grade: B
last_reviewed: 2026-07-14
---

# ADR-0085: Codex App Server is a pinned structured-hybrid provider adapter

- Status: accepted; implementation staged
- Date: 2026-07-14
- Category: product runtime / provider adapter / structured interaction
- Related: [ADR-0079](ADR-0079-native-work-agent-console-loop.md),
  [ADR-0080](ADR-0080-topology-neutral-capability-driven-runtime-activation.md),
  and [ADR-0081](ADR-0081-durable-agent-session-capsule-control-plane.md)
- Contract:
  [kungfu-codex-app-server.contract.json](../../framework/agent-session/kungfu-codex-app-server.contract.json)
- Provider source: [Codex App Server](https://developers.openai.com/codex/app-server)

## Context

ADR-0081 establishes one provider-neutral Agent Interaction Port and a PTY-owning
Capsule path. Codex also publishes an App Server protocol for rich clients over
newline-delimited JSON on stdio. Its typed thread, turn, item, approval, tool,
usage, and error events can provide stronger authority than terminal text for a
Codex attempt.

The surface is version-specific and does not provide three properties Kungfu
needs for an unguarded primary transport: reconnect replay or a cursor, provider
at-most-once input admission, and a documented stdio slow-consumer contract.
`clientUserMessageId` is correlation data, not an idempotency receipt. A provider
thread id also does not prove continuity across a lost pipe or a transport
switch.

A lowest-common-denominator transport would discard Codex's structured
authority, while making it the new shared session authority would duplicate
ADR-0081. The adapter therefore needs an exact, provider-specific boundary.

## Decision

### 1. Codex structured attempts use direct stdio and exact pins

The production candidate is local `codex app-server --stdio` with:

- Codex CLI exactly `0.144.3`;
- the non-experimental generated stable schema bundle exactly matching the
  committed manifest;
- `experimentalApi=false`, no WebSocket authority, and no daemon/proxy
  dependency; and
- official ambient Codex CLI authentication, consumed only by the spawned
  provider. Kungfu does not read auth files, tokens, cookies, session databases,
  or hidden provider state.

Any CLI version, schema digest, required field, admitted method, capability, or
deployment change closes admission and requires targeted requalification. There
is no best-effort parser for unknown methods.

### 2. The schema bundle digest is independently reproducible

The manifest parses every generated JSON file, recursively sorts object keys by
ascending UTF-8 bytes, preserves array order, and emits JSON primitives without
whitespace. It records the canonical byte count and canonical-content SHA-256.
This removes generator map-iteration noise without hiding schema changes. Paths
are also sorted by ascending UTF-8 bytes. The bundle preimage contains one
record per file:

```text
<path> NUL <decimal-canonical-byte-count> NUL <lowercase-canonical-sha256> LF
```

The bundle id is SHA-256 of the complete UTF-8 preimage. This algorithm is named
`sha256-path-nul-canonical-json-size-nul-canonical-json-sha256-lf/v1`; it is
insensitive to filesystem enumeration and JSON object iteration order and makes
the aggregate digest independently recomputable.

The pinned `0.144.3` stable bundle contains 267 files and exposes 87 client
requests, one client notification, ten server requests, and 68 server
notifications. The adapter admits only the smaller method allowlist in its
contract. A stable but unmapped provider extension still fails closed.

### 3. Structured events map into the existing Interaction Port

The adapter does not create another WorkConsole, SessionAttempt, journal, fact
store, controller lease, or GUI mutation path. It maps provider messages into
the existing port while retaining the raw provider method and identity through
a private evidence pointer:

| Provider surface | Normalized role |
| --- | --- |
| `initialize`, `initialized` | exact connection and capability handshake |
| `thread/start`, `thread/read`, `thread/resume` | start, recovery observation, and new-attempt semantic resume |
| `turn/start`, `turn/steer`, `turn/interrupt` | instruct, steer, and exact-turn interrupt admission |
| `thread/*`, `turn/*`, `item/*` notifications | typed lifecycle, presentation, tool, usage, and terminal events |
| approval and user-input server requests | exact request/turn/item control targets with default deny |
| JSON response errors and `error` notifications | typed provider errors with retry and terminal effect |

The provider turn identity comes from `turn/started`, not from prose or an
optimistic local allocation. A request acceptance proves admission only. Work
progress, outcome, evidence quality, and task completion remain Profile/KFD
facts.

Raw prompts, transcripts, reasoning, command output, credentials, and identity
data are not public contract data. Public fixtures retain only redacted samples,
method names, schema inventory, counts, hashes, and typed summaries.

### 4. Missing provider guarantees become Kungfu-owned guards

Later runtime stages must add all three guards before product admission:

1. continuously drain stdout into a bounded consumer queue and close new input
   admission before the hard bound;
2. journal Kungfu-owned input and side-effect idempotency keys plus receipts;
   never rely on `clientUserMessageId` for at-most-once behavior; and
3. on pipe/runtime loss before a durable terminal event, mark the old attempt
   `unknown` or `interrupted`. `thread/read` may observe provider state and
   `thread/resume` may seed a new attempt, but neither fabricates event replay.

An outstanding approval or side effect must be resolved, denied, or marked
unknown before recovery.

### 5. Transport route is frozen per attempt

A Codex structured attempt treats structured control and lifecycle events as
authority. PTY is an emergency human presentation/recovery fallback in a new
attempt and its text can never overwrite a structured receipt. There is no
in-flight PTY/App Server hot switch.

Claude remains PTY-authoritative under its separately qualified adapter. This
decision does not copy a private Claude stdio envelope and does not change
Claude or shared PTY semantics.

## Contract and compatibility

`kungfu.codex-app-server.adapter-contract/v1` is an additive provider adapter
contract packaged by `@kungfu-tech/agent-session`. It depends on, but does not
change, `kungfu.agent-session.contract/v1`.

The delivery is minor-version scope because it adds a public optional adapter
surface. Changing the shared interaction authority, provider identity meaning,
attempt boundary, receipt proof, or fail-closed rule requires a new adapter
contract major and an explicit migration.

## Implementation stages

1. Freeze this contract, generated schema manifest, capability snapshot, method
   mappings, redacted fixtures, and live schema-drift gate.
2. Implement the direct-stdio host, continuous reader, and bounded queues.
3. Normalize event, control, approval, usage, terminal, and error receipts.
4. Qualify recovery, idempotency, backpressure, and failure injection.
5. Consume the shared product seam behind a feature flag after ADR-0081 product
   surfaces are stable.
6. Qualify provider routing, real Codex dogfood, Mac Product build, and
   promotion with the PTY route.

Stage 2 is delivered by PR #851: the reader is installed before initialize,
request and server-request ids are correlated exactly, every post-handshake
write carries attempt/generation/process fencing, and the in-memory consumer
queue freezes admission before its hard bound. Runtime or stdout loss leaves the
old attempt outcome unknown and never triggers input replay.

Stage 3 is delivered by PR #855: the provider-private interaction adapter
consumes the fenced runtime event sequence and produces deterministic plans and
typed receipts for lifecycle, item, tool, approval, usage, terminal, and error
traffic. Exact request/thread/turn/item targeting, default-deny controls, one
terminal boundary per turn, contiguous ordering, and immutable plan roots fail
closed without upgrading delivery into semantic work outcome or Profile/KFD
work state.

Stage 4 is delivered by PR #857: a prompt-free durable journal receipt is
written before every provider request or control response. Exact input and
side-effect ids deduplicate completed work to one receipt, while opened or
unknown duplicates reject blind replay. Runtime loss marks unresolved inputs
and approvals unknown before cutting the immutable old attempt; read is
observation-only, resume and PTY fallback require a new attempt, and queue
admission, runtime-fence, journal-gap, and receipt-root drift fail closed. The
guard injects the existing Agent Session journal seam and adds no database or
provider-private state reader.

Stage 5 is delivered by PR #861: an opt-in product adapter freezes the exact
Codex `0.144.3` `app-server --stdio` launch in the reviewed start plan and
routes structured start, instruction, interrupt, exact control response,
status, snapshot, and receipts through the same GUI, CLI, and KFD-3 action
surface. The feature flag is off by default, so existing Codex and Claude PTY
plans and capabilities remain unchanged. One attempt cannot hot-switch routes;
PTY fallback preserves the WorkConsole and provider, retains old structured
receipts, and creates a distinct attempt only after an `unknown` or
`interrupted` boundary. Product receipts still claim no semantic outcome,
Profile/KFD work state, or proof.

Stage 6 convergence makes that structured route the default for new Codex
`0.144.3` attempts. `KUNGFU_AGENT_SESSION_CODEX_APP_SERVER=0` is the explicit
rollback to a new PTY attempt; it never changes an in-flight attempt or erases
its receipts. New structured threads pin `approvalPolicy=untrusted`,
`approvalsReviewer=user`, `sandbox=read-only`, and the reviewed workspace cwd.
The contract now admits three stable-schema notifications observed in real
dogfood—remote-control status, MCP startup status, and account rate limits—as
typed telemetry only. None can become session, work, outcome, or proof
authority.

Authenticated Mac source dogfood against Codex `0.144.3` passes start,
instruction/output, exact approval denial, interrupt, main-process reattach,
and provider exit closure through the structured route. It retains no raw
terminal, prompt, transcript, credential, or private environment value. The
same run shows the current Codex PTY screen no longer matches the pinned PTY
adapter and therefore remains rollback/manual-recovery only. Claude Code stays
PTY-authoritative and its separate approval-modal degradation remains an
explicit provider limit; Codex structured qualification does not overwrite or
upgrade that result.

## Rejected alternatives

### Use WebSocket or daemon/proxy as production authority

Rejected because they are outside the qualified direct-stdio surface and add a
second connection/recovery contract.

### Parse unknown fields and methods best-effort

Rejected because a silent provider drift could change approval, identity, or
terminal semantics without requalification.

### Reuse a provider thread id as the Kungfu attempt id

Rejected because provider resume does not prove pipe continuity, event replay,
idempotency, or controller ownership.

### Let PTY text repair missing structured events

Rejected because text is presentation evidence, not authority for a structured
attempt's control or lifecycle receipts.

## Consequences

- Codex can use its stronger public structured surface without weakening the
  provider-neutral product contract.
- Schema and method drift become visible before runtime admission.
- The manifest is larger than a single aggregate hash but can be independently
  reproduced without provider credentials.
- Runtime and product promotion remain blocked until the three Kungfu-owned
  hybrid guards and real-provider qualification are complete.
