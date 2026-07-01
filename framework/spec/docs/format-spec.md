# Kungfu Fact-Ledger Format — Spec 0.1 (pre-release draft)

- **Format namespace:** `libkungfu:fact-ledger` (stable, domain-free identity)
- **Spec version:** `0.1`
- **Status:** pre-release draft. A version below `1.0` is **not a publishable
  release**: the format may still change without the backward-compatibility
  guarantee until it reaches `1.0`. The guarantees below are the intended stable
  core; some mechanisms (noted at the end) are not yet normative.

## What this is

A **portable fact ledger**: an ordered, append-only, causally-linked record of
events that can be opened and verified **without the runtime that produced it,
and without any particular library**. The format is the product. Reference
implementations exist for convenience, but they are neither required nor a trust
root — any third party can write a conforming reader from this document alone.

It is a general mechanism (born in a production, low-latency trading core). Its
first-class use today is giving **agent runtimes** a record they cannot
misreport — but nothing in the guarantees below is specific to that use.

## Core guarantees

These are the invariants. Violating one means it is no longer this format.
Everything else (storage engine, byte layout, hash algorithm) is replaceable.

### A. An ordered, causal record — topology is the truth

- **Append-only.** A committed event is never rewritten or reordered.
- **Ordered.** Total order within a stream; happened-before preserved across
  causal links.
- **Causality is recorded, not inferred.** Each event carries a pointer to its
  causal parent at write time. The causal graph is not reconstructed after the
  fact.
- **Self-sufficient topology.** Order, time, causality, identity, and
  classification can be fully recovered from the ledger's own records — with no
  external store and no dependency on the runtime that produced it.

### B. Every event carries intrinsic, machine-readable metadata

- **Intrinsic provenance.** Source identity, generation/trigger clocks, and
  schema id + version travel with each event; build/platform provenance travels
  per run. Not in a sidecar.
- **Content commitment.** Each event carries a cryptographic hash of its payload.
  The ledger therefore vouches for payload integrity **even if the payload bytes
  live elsewhere, or are deleted later.**
- **Classification in the spine.** The kind/boundary fields needed for
  topology-level queries live in the fixed record, not only in the payload.

### C. Authority is local and singular

- **Local-first.** Writing, reading, verifying, and redacting need no account,
  network, or service.
- **The authority is the semantics, not the engine.** The truth is these
  invariants — not any storage backend, which is a replaceable implementation
  detail with no external contract.
- **Everything else is subordinate.** Payloads are content attachments, vouched
  for by their hash; every projection, index, cache, or copy is rebuildable from
  the ledger and is never the sole copy of a fact.

### D. Honest and portable

- **Explicit capture boundary.** The ledger declares what it captures and what it
  does not; it never implies completeness it doesn't have.
- **Three states are always distinguishable:** present-and-authenticated,
  explicitly-redacted, and explicitly-absent.
- **Stable, self-describing export.** A versioned, self-describing, runtime-free
  portable artifact can be produced at any time.

## The bundle

A portable bundle is four parts, joined by two kinds of reference and one root:

| Part | Role | How it joins |
| --- | --- | --- |
| **Manifest / provenance** | trust root and honesty boundary | declares format version, hash algorithm, schema versions, build/platform provenance, and the capture boundary |
| **Event log (spine)** | ordered, append-only; topology *is* the truth | each event references out twice: `payload → content hash`, `type → schema`; the causal graph lives entirely in the spine |
| **Blob store** | content-addressed payloads: `hash → bytes` | referenced by the spine per hash; deduplicated; the three states above are distinguishable here |
| **Schema registry** | `type → self-describing schema` (versioned) | referenced by the spine per type; lets a reader decode **without the matching compiled binary** |

**Content hash is the single connective tissue; the manifest is the root of
trust.** A fixed-size hash field buys four things at once: fixed length, a
checksum, deduplication, and tamper-evidence.

### The bundle is decomposable

Drop the blob store entirely — for redaction or slimming — and the spine's
topology plus its content commitments stay intact. "The fact happened" is never
mutable, even when the payload body is removed: what remains is a hash-bearing
tombstone the manifest still vouches for. This is how redaction stays clean
(remove the body, keep the commitment) while append-only holds (the record of
the event is immutable).

## What "verifiable" means

Verification means **recomputing a payload's hash and checking it against the
reference the event carries** (plus the manifest checksum). This always holds.
It does **not** mean two runs produce byte-identical bundles — that is a separate
property, not part of this guarantee.

## Version axes

- **Spec version** (`0.1`) — the authoritative contract, declared in the
  manifest. Consumers render and route off this, never off a package version.
- **Format namespace** (`libkungfu:fact-ledger`) — a stable identity that carries
  **no domain name**. The documentation domain may move; the format identity does
  not.

Version discipline: below `1.0` the format is pre-release and may change without
compatibility guarantees. From `1.0` on, a version bump is an adopter contract —
a minor bump is a backward-compatible addition (an old reader still reads a new
bundle); a major bump is breaking.

## Not yet normative (grows behind the same contract)

Each of these has a machine-addressable slot in the bundle manifest and is filled
by its owning part, without changing the guarantees above:

- Byte/field layouts of the spine and blob references.
- The **schema registry mechanism** (how self-describing schemas are encoded and
  versioned) — under design.
- Error dictionary semantics, capability tables, and conformance vectors.

See the bundle manifest for the current, machine-addressable location of each.
