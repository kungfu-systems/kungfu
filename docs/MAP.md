# Documentation Map

Start here. Find the question you have; follow it to the document that answers
it. This map is meant to be readable by both a person skimming for the right doc
and an agent grounding a specific claim — it is the audit path to the question
behind all the others: *why can I trust this complex thing?*

Each row carries a **plane** — *why* (intent / rationale), *verify* (trust the
running artifact), *use* (consume / extend) — and a **status**:

- `stable` — current and holds.
- `draft` — exists, rough or incomplete.
- `to write` — planned; the material exists (pointer given) but is not yet a
  single doc.
- `blocked` — waits on the build/release infrastructure; cannot be written
  honestly until the artifacts it documents can actually be produced.

The planes are tags, not folders: some documents legitimately serve two planes,
and the map routes a question to whichever doc answers it.

## Map

| Your question | Document | Plane | Status |
|---|---|---|---|
| What is kungfu, in one idea? | [`../README.md`](../README.md) | — | stable |
| What do the terms mean (`kungfu` / `longfist` / journal …)? | [`concepts.md`](concepts.md) | use | stable |
| Why is it built this way? What is load-bearing? | [`design-philosophy.md`](design-philosophy.md) | why | stable |
| Why this versioning / release design (don't replace it naively)? | [`version-release-design.md`](version-release-design.md) | why | stable |
| When must a change open a minor or major (and when must it not)? | [`versioning.md`](versioning.md) (rule: KFD-1, adopted by ADR-0010) | verify | stable |
| Why was a past decision made? | [`../framework/core/docs/adr/`](../framework/core/docs/adr) | why | stable |
| How is the repository layered? | [`architecture.md`](architecture.md) | use | stable |
| What are the known limits / what is *not* yet guaranteed? | [`known-limits.md`](known-limits.md) | verify | stable |
| How do C++ / Python / Node share data zero-copy (the membrane)? | [`architecture.md`](architecture.md) (membrane diagram) | verify | stable |
| What does it actually guarantee (layout / replay / compatibility)? | [`contracts.md`](contracts.md) | verify | stable |
| What is the event / journal / replay model? | [`event-model.md`](event-model.md) | use | stable |
| Where are the Python / Node / framework adapter boundaries? | [`adapters.md`](adapters.md) | use | stable |
| How do I go from source to a binary? | [`buildchain.md`](buildchain.md) (+ [`../CONTRIBUTING.md`](../CONTRIBUTING.md)) | use | stable |
| Where does a release binary come from, and how do I verify it? | `provenance.md` | verify | blocked · needs release infra |
| What gates must a release pass? | `provenance.md` + [`version-release-design.md`](version-release-design.md) | verify | partial |
| If kungfu itself misbehaves, how do I localize it? | [`debugging.md`](debugging.md) | verify | stable |
| How do I record an agent run and find why it failed (Rewind)? | [`rewind.md`](rewind.md) | use | stable · pre-release install path |
| How do I write an extension (`kfx`)? | [`extensions.md`](extensions.md) | use | stable · view kfx; runtime facets mid-migration |
| What license, trademark, service-use, and provider-compliance boundaries apply? | [`../LICENSE-POLICY.md`](../LICENSE-POLICY.md) + [`../TRADEMARK.md`](../TRADEMARK.md) + [`../ACCEPTABLE_USE.md`](../ACCEPTABLE_USE.md) + [`../PROVIDER_COMPLIANCE.md`](../PROVIDER_COMPLIANCE.md) | use | stable |

## Also asking about

The rows above are phrased as questions; if your wording differs, these keywords
route to the row that answers them:

- **arm64 / Apple Silicon / weak memory ordering / torn frames** → *what does it
  actually guarantee* ([`contracts.md`](contracts.md)) and *why was a decision
  made* ([ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md)).
- **thread-safety / concurrency / single-writer multi-reader / lock-free** →
  *what does it actually guarantee* ([`contracts.md`](contracts.md)).
- **determinism / reproducibility / record-and-replay** → *what does it actually
  guarantee* ([`contracts.md`](contracts.md)) and *the event / journal / replay
  model* ([`event-model.md`](event-model.md)).
- **latency / performance / zero-copy / serialization** → *the membrane*
  ([`architecture.md`](architecture.md)) and *the event model*
  ([`event-model.md`](event-model.md)).
- **how do I run it / get started / install** → *source to a binary*
  ([`buildchain.md`](buildchain.md)) and [`../CONTRIBUTING.md`](../CONTRIBUTING.md).
  (A one-command run-it path is planned — see the build/release work tracked
  in [`known-limits.md`](known-limits.md).)
- **N-API / pybind11 / bindings / FFI** → *adapter boundaries*
  ([`adapters.md`](adapters.md)).
- **signature / checksum / supply chain / SBOM** → *verify a release binary*
  (`provenance.md`, `blocked` — see [`known-limits.md`](known-limits.md)).
- **trademark / fork / hosted service / provider compliance / cost attribution
  boundary** → [`../TRADEMARK.md`](../TRADEMARK.md),
  [`../ACCEPTABLE_USE.md`](../ACCEPTABLE_USE.md), and
  [`../PROVIDER_COMPLIANCE.md`](../PROVIDER_COMPLIANCE.md).

## How this map is maintained

- A document becomes a row here the moment it is *named*, even before it exists —
  so the gap is visible (`to write` / `blocked`), not hidden.
- A row's status must never claim more than the artifact delivers. A document
  that asserts a guarantee should also say where to verify it and how mature that
  guarantee is.
- `why` documents explain intent and may be read as narrative; `verify` and
  `use` documents are reference paths and should state, per claim, *what it
  guarantees → where to verify → current maturity*.
