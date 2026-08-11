# Git Workspace Episode provider

This build-free provider stores a qualified, sealed Kungfu Episode as one
immutable Git-friendly segment. It is a shadow representation of the
yijinjing authority, not a second Episode fold, query, fsck, or root engine.

Tracked layout:

```text
.kungfu/episodes/sealed/sha256/<prefix>/<episode-root>/
  manifest.json
  claims.jsonl
  qualification.json
```

The provider creates `.kungfu/.gitignore` on first use with `runtime/`,
`inbox/`, `episodes/.tmp/`, `private/`, `cache/`, `locks/`, and `projections/`.
For backward compatibility, an existing file must contain the original first
five entries; the provider never silently widens or overwrites repository
ignore policy.

Open state, writer leases, private material, projections, caches, and temporary
seals stay local under `.kungfu/runtime/episode-provider/` or
`.kungfu/episodes/.tmp/`. Repositories should ignore both locations. One JSONL
file belongs to one immutable Episode; there is no global ledger, numeric
allocator, or publication lock.

The provider admits only a thin `kungfu.storage.episode-bundle/v1` whose
recorded root is accompanied by `kungfu.episode.qualification/v1` evidence from
the C++ typed fold/fsck. The canonical qualification preimage is tracked beside
the claims so a fresh checkout can recompute `qualificationRoot`; it contains
typed fsck evidence, not runtime journals, payloads, or private material. The
provider preserves that `kungfu.episode-root/v1` identity but
does not recompute it from JSON. Its separate `providerRoot` commits to the
canonical JSONL bytes and manifest under
`sha256-kungfu-git-episode-canonical-json-v1`. Therefore provider-native equality is not
silently promoted to Episode semantic equality.

## Public schemas and framing

The versioned provider schemas are public under [`schema/`](schema/):

- `git-workspace-manifest-v1.schema.json` covers the sealed manifest, claims
  index, content-reference closure, dependency closure, and all three roots;
- `git-workspace-segment-v1.schema.json` covers each `claims.jsonl` row;
- `episode-qualification-v1.schema.json` covers the C++ typed-fold/fsck
  qualification preimage admitted by this provider;
- `git-workspace-provider-contract-v1.schema.json` welds those schemas to the
  shadow-provider authority boundary.

Objects use NFC strings, non-negative safe JSON integers, recursively sorted
UTF-8 object keys, compact JSON, and one final LF. Claims contain exactly one
canonical row per line, end in LF, and use contiguous zero-based `index`
values. The manifest `claims.digest` hashes the original JSONL bytes and
`claims.count` equals the row count. `contentRefs` are unique roots sorted by
UTF-8 bytes. Native dependency closure records retain their declared order and
remain opaque to the shadow verifier; their bytes are nevertheless bound by
`providerRoot`.

Runtime `uint64` values at or below `2^53-1` use JSON integers. Larger values
use unsigned base-10 strings with no sign or leading zero and must not exceed
`18446744073709551615`. The schema recognizes the wire shape; the provider's
contract test enforces the numeric boundary that JSON Schema cannot express as
a decimal-string comparison.

An independent verifier may recompute the claims byte digest,
`qualificationRoot`, and `providerRoot`, validate closure framing, and confirm
that all declarations agree. It must not derive or replace `semanticRoot`:
that root remains the recorded `kungfu.episode-root/v1` from yijinjing and is
admitted only with `policy_source=cpp-typed-fold-fsck`, an ended lifecycle, an
`ok` result, and safe `export_evidence` capability.

Runtime `uint64` tokens are read losslessly. Values above the cross-language
safe-integer range are represented in tracked claims as decimal strings, and
the manifest binds
`uint64-decimal-string-above-safe-range/v1`; JavaScript never rounds a runtime
timestamp or identifier before Xinfa consumes the shadow.

The seal path uses a per-Episode exclusive lease, sibling temporary directory,
file and directory fsync, and atomic rename. Different Episodes share no lock.
Faults before rename remain visible as incomplete temporary seals; published
segments are never modified in place. Re-import of identical roots is a no-op,
while the same semantic root with different provider bytes is rejected.

Run the deterministic contract and fault fixtures:

```sh
node --test scripts/check-git-episode-provider.test.mjs
```

This stage does not migrate a real `.kungfu`, replace yijinjing authority,
commit raw transcript/payload bytes, or claim file/RocksDB payload-provider
identity as a separate Episode semantic contract.
