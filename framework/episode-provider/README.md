# Git Workspace Episode provider

This build-free provider stores a qualified, sealed Kungfu Episode as one
immutable Git-friendly segment. It is a shadow representation of the
yijinjing authority, not a second Episode fold, query, fsck, or root engine.

Tracked layout:

```text
.kungfu/episodes/sealed/sha256/<prefix>/<episode-root>/
  manifest.json
  claims.jsonl
```

The provider creates `.kungfu/.gitignore` on first use and refuses an existing
file that does not ignore `runtime/`, `episodes/.tmp/`, `private/`, and
`cache/`. It never silently widens or overwrites repository ignore policy.

Open state, writer leases, private material, projections, caches, and temporary
seals stay local under `.kungfu/runtime/episode-provider/` or
`.kungfu/episodes/.tmp/`. Repositories should ignore both locations. One JSONL
file belongs to one immutable Episode; there is no global ledger, numeric
allocator, or publication lock.

The provider admits only a thin `kungfu.storage.episode-bundle/v1` whose
recorded root is accompanied by `kungfu.episode.qualification/v1` evidence from
the C++ typed fold/fsck. It preserves that `kungfu.episode-root/v1` identity but
does not recompute it from JSON. Its separate `providerRoot` commits to the
canonical JSONL bytes and manifest under
`sha256-kungfu-git-episode-canonical-json-v1`. Therefore provider-native equality is not
silently promoted to Episode semantic equality.

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
