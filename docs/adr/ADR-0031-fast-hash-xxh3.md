---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0031
decision_status: accepted
implementation_status: partial
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0031: fast internal hashes use XXH3

- Status: accepted
- Date: 2026-07-08
- Category: runtime identity
- Subsystem: yijinjing fast hash helpers, Python/Node bindings, locator ids.
- Related: ADR-0028 separates hash surfaces. ADR-0029 defines frame receipt
  checksums. ADR-0030 defines the first manifest sync root.

## Context

Kungfu v4 is still greenfield and has not carried production data that must keep
old trading-era uid values stable. That makes this the correct time to remove
the old internal fast-hash implementation instead of preserving it as hidden
compatibility debt.

The runtime still needs a fast deterministic non-cryptographic hash for internal
ids, location uid derivation, and in-process hash keys. It does not need that
function to be a content hash, a receipt checksum, or a trust proof.

## Decision

Kungfu uses xxHash 0.8.3 and the XXH3 family for internal fast hashing:

- `fast_hash_64` and `fast_hash_str_64` use `XXH3_64bits_withSeed`.
- `fast_hash_string_128` uses `XXH3_128bits_withSeed` and returns the canonical
  16-byte digest.
- `fast_hash_32` remains as a narrow helper for legacy-width runtime ids, but it
  is derived from the XXH3 64-bit result rather than a separate algorithm.
- `FAST_HASH_ALGORITHM` is `xxh3_64`.
- `FAST_HASH_ALGORITHM_64` is `xxh3_64`.
- `FAST_HASH_ALGORITHM_128` is `xxh3_128`.

The binary digest helpers return canonical digest byte lengths:

- `fast_hash_string_32`: 4 bytes.
- `fast_hash_string_64`: 8 bytes.
- `fast_hash_string_128`: 16 bytes.

The old implementation is removed from active source code rather than retained
behind a switch.

## Consequences

- New v4 data will derive internal runtime ids from XXH3, not from the old
  trading-era helper.
- 32-bit ids remain collision-prone by design and must only be used where the
  runtime surface still requires a narrow id.
- Storage payload identity, export manifests, and sync roots remain on explicit
  content hashes and root proofs such as `sha256`; they must not call
  `fast_hash_*`.
- Python and Node bindings expose algorithm metadata so tests and tools can
  assert which fast-hash family is active.

## Alternatives considered

- **Keep the old helper for compatibility.** Rejected. v4 has not entered
  production, and carrying a hidden compatibility branch would make future
  storage and sync work harder to reason about.
- **Use SHA-256 or BLAKE3 for internal ids.** Rejected. Those are content /
  cryptographic hash families. Internal uid derivation needs speed and stable
  deterministic output, not cryptographic strength.
- **Implement XXH3 manually.** Rejected. The reference xxHash implementation is
  mature, portable, and already available through ConanCenter as `xxhash/0.8.3`.
