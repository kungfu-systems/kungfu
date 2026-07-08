# ADR-0023: frame integrity starts at the C++ recorder and raw msg_type allocation is gated

- Status: accepted
- Date: 2026-07-08
- Category: (architecture) journal integrity and v4 event allocation
- Subsystem: yijinjing journal writer, libkungfu action recorder, fsck/export,
  Rewind, Work, KFX schema registration, CI/source-quality gates.
- Related: ADR-0001 defines the publish barrier. ADR-0018 defines runtime
  storage as the persistence contract. ADR-0022 defines the C++ action recorder
  as the polyglot membrane.

## Context

The trading-era journal optimized for low-latency publication. `frame_header`
contains enough structure to publish, route, filter, and replay frames, but it
does not contain a per-frame checksum. The `length` field is the publication
token: it proves a reader does not observe a half-written frame, not that the
frame was never corrupted or changed after publication.

The v4 agent/runtime use case changes the tradeoff. Agent facts are durable
evidence. They need low-cost integrity checks even when the full cryptographic
or multi-machine sync story is staged later.

At the same time, earlier dogfood slices used pre-envelope open-layer msg_type
allocations (`300xx`, `301xx`, `400xx`). Those ranges remain useful historical
compatibility material, but copying that pattern into new v4 work would
re-couple business semantics to raw journal integers.

## Decision

New v4 business facts must not allocate raw business `msg_type` numbers. They
use the action-envelope carrier (`msg_type=1000`) and put business semantics in
`action_type` plus `schema_ref`.

The repository enforces this with a source-quality gate. New raw `300xx` /
`400xx` allocations fail unless the file is in an explicit legacy allowlist.
The allowlist is for preserving existing Rewind/Work/KFX surfaces, not for
expanding the model.

Frame integrity begins in the C++ action-recorder membrane:

- `action_recorder` computes a fast payload checksum and frame checksum when it
  writes a frame.
- The receipt exposes `integrity_version`, `payload_checksum`, and
  `frame_checksum` through C++, Python, and Node.
- Higher layers that persist receipts, such as the Atlas import manifest, can
  run fsck by reopening journal frames and recomputing those checksums.

The first checksum algorithm is a fast non-keyed 64-bit FNV-1a implementation.
This is a corruption detector, not a cryptographic authenticity proof.

## Trailer and hash-chain direction

A full journal-format v2 should add a frame trailer or equivalent integrity
region written before the final `length` release-store. That design must
preserve ADR-0001: the checksum/trailer is fully written before the frame is
published, and `length` remains the final visibility token.

A single checksum detects accidental corruption and uncoordinated mutation. It
does not make the frame tamper-proof, because an attacker who can rewrite the
frame can also rewrite a non-keyed checksum. Tamper evidence requires a
chain-level commitment, for example:

- previous frame checksum/hash;
- current header/payload/trailer checksum;
- stream/session/page root;
- exported manifest or remote sync receipt binding that root.

That chain is a separate compatibility surface and should be delivered as a
later stage after the receipt-based slice proves the API and fsck flow.

## Consequences

- Future agents must add action schemas, not raw `msg_type` constants, for new
  product/runtime facts.
- Rewind and Work remain pre-envelope compatibility surfaces until deliberately
  migrated.
- KFX dynamic schema examples remain legacy; sandboxed extensions should not
  treat `40000-49999` as the preferred v4 business event model.
- fsck can detect changed action-envelope payload/header facts when the receipt
  has integrity fields.
- Existing journals remain readable. They simply lack integrity receipt fields
  unless written by the new recorder.

## Alternatives considered

- **Put checksum fields directly into `frame_header`.** Rejected for the first
  slice. It changes the binary layout and the publish-size assumptions, so it
  needs a journal-format migration decision.
- **Append a trailer immediately.** Deferred. Existing readers calculate
  `data_length = frame_length - header_length`; a naive trailer would be read as
  payload by old code unless the header/layout is extended.
- **Rely only on exported manifest hashes.** Rejected as insufficient. Manifest
  hashes protect exported artifacts, not the frame as the smallest runtime fact.
- **Use a cryptographic hash immediately.** Deferred. A faster checksum is
  enough for the first corruption-detection slice; tamper evidence belongs to a
  chain/root design.

## Residual risk

- Receipt-based integrity is only as durable as the layer that persists the
  receipt. Full journal-native trailer integrity is still future work.
- The v1 receipt checksum defines an implementation-level scalar order for the
  current writer/fsck path. A future journal-native trailer must freeze a
  portable byte encoding as part of the format contract.
- FNV-1a is not cryptographic. Do not describe it as security against a capable
  attacker.
- Legacy open-layer ranges are still present. The gate prevents new accidental
  allocations but does not migrate old surfaces by itself.
