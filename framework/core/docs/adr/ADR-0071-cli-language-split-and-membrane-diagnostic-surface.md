---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0071
decision_status: accepted
implementation_status: not-started
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-decision]
period: 2026-07-13
theme: cli-implementation-language-split
confidence: medium
evidence_grade: B
last_reviewed: 2026-07-13
---

# ADR-0071: CLI implementation split — Rust trunk vs Python, and growing the embedding membrane's diagnostic surface

- Status: accepted (evaluation + direction); implementation deferred to a follow-up
- Date: 2026-07-13
- Category: CLI architecture / host boundary / embedding membrane
- Related: [ADR-0046](ADR-0046-rust-host-trunk-and-assembled-runtime.md)
  (Rust host trunk owns `main()`, layered CLI, embedding membrane),
  the embedding-contract-face RFC (`docs/embedding-contract-face.md`, the single
  versioned C ABI the trunk links)

## Context

After ADR-0046 stage 3 the `kungfu` CLI is split by a layering law — *whoever
implements the semantics parses the argv*:

- **Rust trunk** (`crates/trunk`, clap-style) owns `env`, `prewarm`, `doctor`,
  the root `--version`/`--help` (rendered from a shipped manifest), and the
  `KUNGFU_AS_VARIANT=node` native variant. These never boot CPython.
- **Python** (`framework/core/src/python/kungfu/cli/commands/*.py`, click) owns
  the ~24 domain commands; the trunk forwards everything else argv-transparently
  to `python -m kungfu`.

A recurring question is which further commands should move to Rust. The naive
framing — "clap is nicer than click" — is not the deciding factor; parser
ergonomics are marginal. The real axes, grounded in what each command does, are:

1. **Runtime dependency** — does it need CPython + the fat pybind binding
   (`kungfu.__binding__.runtime`) + the Python ecosystem (extension/plugin
   model, node/electron bridge)?
2. **Must-work-when-broken** — is it a diagnostic/repair that must run when the
   domain runtime itself is down (the `doctor`/`fsck` archetype)?
3. **Perf profile** — a tight loop over large on-disk substrate where CPython
   overhead bites, vs. orchestration where startup dominates and work is
   subprocess/IO-bound?
4. **Churn** — a stable mechanical primitive vs. a fast-evolving product/UI/
   extension surface (a Rust rewrite of a churning surface is a permanent tax).

### Grounding facts that decide it

- **Every Python command loads the fat pybind binding at startup**
  (`import kungfu` → `kungfu.__binding__`), and the root callback constructs
  journal locators for all but `{workspace, managed-run, storage}`. The Rust
  trunk over the slim embedding membrane loads only `libkungfu` — genuinely
  lighter startup.
- **The embedding membrane exposes only two things today**: read-only journal
  **batch read** (`reader_read_batch`, borrow-mmap frame views) and **capability
  negotiation**. `doctor` (`crates/trunk/src/doctor.rs`) is its only consumer.
  This is the ceiling on what a Rust command can reach.
- **`storage` / `facts` / `query` / `schema` heavy lifting already lives in
  C++ core** — the Python command is a thin marshaller over
  `storage_service → _runtime().storage_*_typed(...)` /
  `runtime.compile_schema(...)`. But that C++ surface is reachable **only through
  the fat pybind binding**, which the membrane does not expose. So a Rust
  command cannot reach `storage_fsck_typed` today, not because the compute is
  Python, but because the narrow contract face does not surface it.
- **`rewind` / `work` / `atlas`-import folds run the heavy loop in Python** — a
  CPython per-frame FlatBuffers-reflection decode over raw journal frames. The
  membrane *can* already hand those raw frames to a Rust process via
  `reader_read_batch`; the fold/decode logic is what lives in Python.
- **`fsck` / `gc` / `compact` compute is already native C++.** A Rust `fsck`
  would not compute faster; its value is that it runs **without booting
  CPython + pybind** and **survives a broken runtime** — the same reason
  `doctor` is Rust-native.

## Decision

Judge CLI-language fit by *where the work already lives and whether Rust can
reach it via the membrane*, not by parser ergonomics. This yields three buckets
and one strategic lever.

### Bucket A — strong Rust fit: substrate diagnostics/maintenance (the doctor/fsck archetype)

`storage` (fsck / verify / repair / gc / compact / verify-sync / rebuild-index /
layout / status), `schema compile`, `facts` admission.

Rationale: the logic is already C++; no Python-ecosystem dependency; must survive
a broken runtime; startup latency matters. **These are the right Rust targets —
but they are blocked on the lever below, not on a rewrite.**

### Bucket B — Rust would help, but needs a logic rewrite (measure first)

`rewind verify`, `work list/show`, `atlas import` fold, `source fsck`.

Rationale: these run a CPython hot loop decoding every journal frame — the one
place raw perf actually bites — and the membrane already supports the read path.
Moving them means rewriting the fold/decode (incl. FlatBuffers reflection) in
Rust: medium cost, real perf payoff **only if measurement shows the per-frame
CPython loop is felt on real journal sizes**. Do not migrate on faith.

### Bucket C — stays Python (Rust gives nothing or is negative)

`cockpit`, `kfx`, `sdk`, `kfd` (node/electron + extension + UI), `engage`,
`managed-run`, `trace`, `runtime` service-management, `remote`, `skill`,
`codex`, `report`, `agent`, `workspace`, `config`, `contract`.

Rationale: subprocess/IO/node-bound (startup is not the cost), or fast-churning
product/extension/UI surfaces where a Rust rewrite is a permanent maintenance
tax. `config`/`contract`/`workspace` are technically mechanical-over-files but
tiny, high-churn, and have no perf or must-work-when-broken need — pure cost.

### The lever: grow the membrane's read-only diagnostic surface, don't rewrite commands

The membrane is the ceiling. The highest-leverage move is **not** rewriting a
command in Rust — it is **extending the embedding membrane's C ABI with a
read-only substrate-diagnostic surface** (fsck / verify / gc-plan / query-plan /
schema-compile as read-only entries), then putting thin Rust CLIs over it. That:

- reuses the C++ logic verbatim (zero domain-logic rewrite),
- gives the whole storage surface the `doctor` property (works when the runtime
  is down),
- keeps one narrow, versioned contract face rather than a second god-object FFI
  into the fat pybind binding,
- is a direct extension of the pattern already shipped in ADR-0046 stage 3.

`fsck` is `doctor`'s natural sibling and the right first target after `doctor`.

## Consequences

- **Positive**: substrate diagnostics/repair gain the must-work-when-broken
  property; Bucket A needs no domain-logic rewrite; the Rust path stays lighter
  at startup than the CPython + pybind path.
- **Cost / maintenance surface**: growing the membrane widens a contract face —
  it must stay **narrow and versioned** (read-only diagnostic entries first) to
  avoid recreating a god object. Bucket B carries a genuine rewrite cost gated
  on measurement.
- **Explicit non-goals**: do **not** migrate `config`/`contract`/`workspace` to
  Rust (pure cost); do **not** touch the product/extension/UI/provider surfaces
  (Bucket C) — that is correct placement, not legacy debt.
- **Open judgment point (not yet grounded)**: whether Bucket B is worth the
  rewrite depends on the per-frame CPython decode latency at real journal sizes.
  Measure one real `rewind verify` / `work list` workload before committing.

## Alternatives considered

1. **Per-command Rust rewrite, domain logic and all.** Rejected: for
   `storage`/`facts`/`query`/`schema` the logic is already C++, so a rewrite
   either duplicates it in Rust or builds a second fat FFI (a god object) — both
   worse than exposing the existing C++ through a narrow membrane entry.
2. **Leave everything in Python.** Rejected: forfeits the must-work-when-broken
   property for `fsck`/`doctor`-class tools and the lighter Rust startup, for no
   benefit.
3. **FFI directly into the fat pybind binding from Rust.** Rejected: pybind is
   not a stable C ABI and is a god object; it violates the single narrow
   contract-face principle the embedding membrane was created to hold.
4. **Migrate on "clap > click".** Rejected: parser ergonomics are marginal and
   not an architecture axis.

## Follow-up

- Implementation of Bucket A (grow the membrane's read-only diagnostic surface,
  then ship a Rust `fsck` / `storage verify`) is tracked as an Atlas go card,
  not scoped in this ADR.
- Bucket B is measurement-gated; open a separate item only if a real workload
  shows the CPython fold is felt.
