---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: KF-ADR-019fdb93-19ac-7362-8ab0-f8ed19c7bef8
decision_status: accepted
implementation_status: staged
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/2590, https://github.com/kungfu-systems/kungfu/pull/2618, https://github.com/kungfu-systems/kungfu/pull/2704, https://github.com/kungfu-systems/kungfu/pull/2953]
qualification_refs: [framework/assignment-runtime/assignment-runtime.contract.json, framework/assignment-runtime/schema/assignment-runtime-envelope-v1.schema.json, framework/assignment-runtime/fixtures/contract-cases-v1.json, framework/assignment-runtime/assignment-runtime.test.mjs, framework/assignment-runtime/consumer-inventory-v1.json, framework/api/tests/assignment-runtime.test.ts, framework/core/tests/python/test_assignment_runtime.py, framework/core/tests/python/test_work_control_profile.py, framework/gui/src/main/assignment-runtime-host.test.ts, extensions/work-control/work-control-actions/domain/work_semantics.py, extensions/work-dashboard/tests/work-control-profile.test.ts, docs/architecture/assignment-runtime-r0-evidence.md, docs/architecture/assignment-runtime-r1-local-profile.md, docs/architecture/assignment-runtime-r2-gui-client.md]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: 2026-08-07
theme: local-first-assignment-runtime-api
confidence: high
evidence_grade: A
last_reviewed: 2026-08-24
ai_provenance: GPT-5 via Codex on 2026-08-11 and 2026-08-24; based on the exact R0 through R3 Assignment artifacts, protected delivery in PRs 2590 and 2618, review history in PR 2704, the R3 source candidate in PR 2953, disposable-Home qualification, and the current generic Work-semantics source candidate and focused tests; protected delivery of the current candidate, Product qualification, independent downstream adoption, and any Cluster Runtime cutover are not claimed
---

# KF-ADR-019fdb93-19ac-7362-8ab0-f8ed19c7bef8: Assignment clients converge on one local-first transport-neutral Runtime API

- Status: accepted; R0 contract and R1 Local Profile delivered, R2 GUI and R3 client convergence staged, generic Work-semantics source candidate
- Date: 2026-08-07
- Category: Work Control / Assignment Runtime / client boundary
- Related: [Assignment orchestration](KF-ADR-019f87cc-bd1f-786d-896d-07ea9245861e.md),
  [Assignment claim identity](KF-ADR-019f87cc-bd45-7a5c-9b37-1d6b5917928a.md),
  [workspace Home layout](KF-ADR-019f86da-4f90-713d-8626-d70bca82cb76.md), and
  [runtime activation](KF-ADR-019f86da-4f90-738c-b372-e509976f69ff.md)

## Context

Kungfu already has one fact-backed Work Control authority, content-addressed
Assignment capture, bounded execution leases, append-only phase facts, portable
sealed state, and compatibility readers. Its clients do not yet share one
Runtime boundary. The public CLI resolves workspace and runtime coordinates,
loads Profile source, invokes member adapters, and derives `next_actions`; the
Work Dashboard calls the same Profile members directly; Agent discovery
projects CLI commands; KFX contributes actions and views at the Profile layer.

Those paths currently converge on the same domain authority, but their public
boundary includes implementation choices. Adding a remote or replaceable
backend independently to each client would create transport coupling, duplicate
folds, or a silent second writer. Declaring the physical `.kungfu` layout as the
API would also make a later implementation replacement impossible.

## Decision

### 1. One versioned Runtime API is the client boundary

`kungfu.assignment-runtime/v1` is the pre-release protocol used by GUI, CLI,
Agent, and KFX clients. It provides capability discovery, snapshot/list/get/
query, resumable events, command submission and inspection, diagnostics, and
two-step recovery. Requests and responses carry only logical realm and
Assignment identities, generations, revisions, canonical roots, Fact/Episode
references, receipts, and stable diagnostics.

Filesystem paths, JSON layouts, journal directories, SQLite projections,
PostgreSQL tables, Electron channels, and language-private types are never
public protocol identity. Embedded and authenticated loopback transports are
equivalent Local Profile adapters. A future Cluster adapter may implement the
same contract, but receives no authority or product claim from this decision.

### 2. A realm has one fenced transition authority

One `realm-runtime` owns Assignment transitions for one realm generation.
Clients submit commands; they do not append facts or mutate storage. Every
state-changing command carries the exact expected revision and an idempotency
key. Claim and phase changes also bind the canonical Assignment, attempt, lease
or Warrant, and generation. A stale revision or generation fails before any
mutation.

The same idempotency key with the same body returns the original command and
receipt roots with `disposition=replayed`. The same key with different bytes
fails with `idempotency-conflict`. Runtime unavailability never falls through
to a direct client writer.

### 3. Reads, events, and recovery retain exact authority coordinates

Every successful read reports its observed revision and state root. Equivalent
clients at that revision receive identical identities, roots, Fact/Episode
references, and receipt roots. Event cursors bind stream, realm generation,
sequence, and event root. Reconnect first rediscovers capability and generation;
an expired cursor fails with `event-resume-gap` and names a recovery snapshot
revision rather than guessing a successor.

Diagnostics are observations, not state authority. Recovery is explicitly
planned before execution and remains revision- and idempotency-fenced.

### 4. The Local Runtime Profile is the first implementation target

R1 implements this contract for the selected logical Home or project Workspace
in the protected delivery recorded by PR 2618. The current private
`.kungfu` Fact/Episode/runtime tree remains its
initial backing, not its public API. A command is successful only when its
authoritative receipt is durable; process liveness is diagnostic only. Crash
and reconnect behavior must reproduce the same revision, cursor, and receipt
semantics through embedded and loopback adapters.

R1 must retain current compatibility readers and migration seams. It must not
allow caller-owned storage mutation or enable a second writer during cutover.

### 5. Client convergence is phased and deletion is evidence-gated

R0 freezes the contract, schemas, fixtures, and source inventory only. R1
implements and qualifies the Local Runtime Profile. R2 moves GUI reads and
writes behind a Runtime Client. R3 converges CLI, Agent, and KFX, then performs
a reverse scan for direct paths and semantic parity.

Existing paths remain visible implementation facts until their successor has
exact-root parity evidence. A compatibility alias or direct path may be removed
only through an explicit reviewed deletion gate. No phase uses dual write as a
migration technique.

PR 2953 is the current R3 source candidate. It routes CLI, Agent, and KFX
consumers through the versioned Runtime application edge and retains an exact
consumer inventory and focused qualification. This record does not treat that
source candidate as protected delivery or Product qualification before those
external gates settle.

### 6. Generic Work semantics belong to the Runtime authority

The Runtime boundary owns the domain-neutral semantics that make an Assignment
safe to execute and settle: immutable input snapshots and invalidation,
managed-run evidence, bounded effect authorization, effect attempt and outcome
records, Completion Claims, independent review, continuation decisions, and
portable sealing. These operations remain expected-revision-, lease-, actor-,
and idempotency-fenced and return content-addressed receipts through the public
Work Control action surface.

Downstream products may retain business-domain planning, payload construction,
transport adapters, and outcome interpretation. They must not recreate generic
Work state, synthesize local authority when Kungfu is unavailable, or treat a
transport response as a business outcome. An ambiguous effect attempt remains
recorded as ambiguous and cannot be blindly retried; diagnostic degradation is
read-only and grants no fallback mutation path.

The current source candidate exposes these operations through the installed
Work Control Profile and exercises their native fold with focused Python,
contract, dashboard, CLI, and KFD evidence. It does not claim protected
delivery, release admission, or downstream Product certification before those
separate gates settle.

## Falsification and qualification

The contract is false if:

- two writers can transition one realm generation;
- a stale revision, fenced generation, expired lease, or invalid Warrant can
  mutate state;
- replaying an identical command produces a second authoritative receipt;
- client kind or transport changes canonical identities or roots;
- an unavailable Runtime causes a GUI, CLI, Agent, or KFX storage fallback;
- a downstream product can mint generic Work authority or blindly retry an
  ambiguous authorized effect outside the Runtime fold;
- event resume skips an unknown gap or changes generation silently;
- a public envelope exposes backend paths or database/Electron internals; or
- the R0 artifacts report Local or Cluster implementation as delivered.

R0 qualification compiles the request/response schema and runs in-memory
success, stale revision, duplicate command, unsupported capability, malformed
or ambiguous identity, backend unavailable, event resume gap, and authority
bypass fixtures. R1-R3 require separate implementation and product evidence.

## Consequences

Kungfu gains one stable boundary for local-first Assignment clients without
promoting a storage layout into an API. The explicit revision, generation,
idempotency, event, and error contract makes a future backend adapter possible
without prepaying for distributed infrastructure. The cost is a deliberate
multi-phase migration: existing client paths remain until exact successor
evidence proves they can be removed.
