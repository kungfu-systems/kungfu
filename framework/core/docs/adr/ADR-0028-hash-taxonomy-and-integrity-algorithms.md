# ADR-0028: hash taxonomy separates internal ids, frame checksums, and content hashes

- Status: accepted
- Date: 2026-07-08
- Category: (architecture) storage integrity and runtime identity
- Subsystem: yijinjing hash helpers, runtime action recorder, storage manifests,
  fsck/export, Python/Node bindings.
- Related: ADR-0001 defines the publish barrier. ADR-0018 defines runtime
  storage. ADR-0022 defines the C++ action recorder membrane. ADR-0023 defines
  receipt-based frame integrity.

## Context

Kungfu historically used legacy trading-era fast hash helpers through generic
names such as `hash_32` and `hash_str_32`. That was acceptable for low-latency
internal ids, but the v4 runtime now also stores agent facts, import/export manifests, payload
inventories, fsck reports, and future remote-sync receipts.

Those surfaces need different hash semantics:

- internal ids and hash-map keys must be fast and deterministic;
- frame receipts need a cheap corruption detector;
- content-addressed payloads and manifests need stable algorithm-tagged content
  hashes;
- future trust proofs need chain/root semantics, not a bare non-keyed checksum.

Using one generic "hash" vocabulary for all of those would make it too easy for
new code to use a fast non-cryptographic helper as a content-addressing or
tamper-evidence primitive.

## Decision

Kungfu treats hashes as four separate surfaces:

1. **Fast internal hash**: yijinjing exposes `fast_hash_*` APIs. The current
   implementation is XXH3. The 64-bit algorithm label is `xxh3_64`; the 128-bit
   algorithm label is `xxh3_128`. This is
   only for internal ids, location uid derivation, in-process keys, and
   deterministic bucketing. It is not a content hash and not a security proof.
2. **Frame checksum**: action-recorder receipts use versioned non-keyed
   corruption detectors. V1 is 64-bit FNV-1a, labelled `fnv1a64`; v2 is CRC32C,
   labelled `crc32c` (ADR-0029). They detect accidental corruption or
   uncoordinated mutation in the writer/fsck path. They are not cryptographic
   authenticity proofs.
3. **Content hash**: storage manifests, payload references, schema inventories,
   and import/export payload bodies use explicit content hash algorithms.
   `sha256` is the default v4 portable baseline; `blake3` is reserved as a
   future supported option when the dependency and cross-language bindings are
   deliberately added.
4. **Trust proof / sync root**: future tamper evidence must bind frame or
   payload hashes into a stream/session/page/manifest root. That is a separate
   journal or remote-sync compatibility surface, not a reason to overload the
   fast hash or receipt checksum APIs.

The repository enforces the naming boundary:

- C++ internal runtime code uses `fast_hash_*`, not generic `hash_*` names.
- Python keeps `hash_32` / `hash_str_32` as compatibility aliases, while new
  internal Python runtime code uses `fast_hash_str_32`.
- Storage code must not use `fast_hash_*` for content hashes.
- The runtime greenfield gate blocks reintroducing ambiguous C++ hash names in
  changed core files.

## Consequences

- A future reader can tell from the function name whether a hash is safe for
  internal ids only or suitable for storage content identity.
- Existing Python user scripts are not broken immediately, but new code has the
  explicit `fast_hash_*` API available.
- Fsck/export manifests can record both checksum values and the checksum
  algorithm, so a later algorithm change can be detected instead of silently
  recomputed with the wrong function.
- XXH3 gives the internal-id path a fast non-cryptographic baseline without
  making it the implied answer to every hash-shaped problem.

## Alternatives considered

- **Use BLAKE3 everywhere.** Rejected. Internal uid and hash-map use does not
  need a cryptographic hash, and uid derivation remains a runtime identity
  decision separate from storage integrity.
- **Use SHA-256 for frame receipts immediately.** Rejected for the first
  receipt slice. The current writer/fsck path needs a cheap corruption detector;
  cryptographic trust belongs to a chain/root design.
- **Keep `hash_*` as the public C++ vocabulary.** Rejected. The name is too
  broad and encourages content-hash misuse.
- **Add BLAKE3 now.** Deferred. It is a good future content-hash option, but it
  should arrive with intentional dependency, binding, and manifest negotiation
  work rather than as a hidden runtime dependency.

## Residual risk

- Python compatibility aliases still exist. They should be treated as stable
  compatibility surface, not the recommended internal API.
- `fnv1a64` and `crc32c` are receipt checksums, not security claims.
  Documentation and fsck output must continue to avoid describing them as
  tamper-proof.
- Full tamper evidence still requires a chain/root design and journal-format or
  remote-sync compatibility work.
