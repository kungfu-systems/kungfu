# content-store slice

Probe statement: the yijinjing kernel offers one first-class immutable
content-addressed store (ADR-0040) whose dependency-free file backend proves
its contract obligations on this machine, standalone, with no engine
dependency.

What the probe proves:

- **Atomic publish (put-if-absent)**: bytes are staged under `tmp/` and
  renamed onto their content digest; a first put publishes, a repeated put is
  a dedup hit, and publish leaves no temp residue.
- **Hash mismatch rejection**: a put whose bytes do not hash to the caller's
  declared digest is rejected and stores nothing; verify of an absent digest
  is `not_found`.
- **Crash-safe visibility**: a torn final object (crashed non-atomic writer)
  fails `verify` and never comes back from `get`; same-length tampering is
  caught on every read path; temp residue is invisible to lookups.
- **Verified reads**: `get` returns bytes only after they re-hash to the
  digest.
- **Declared semantics**: capability discovery (profile, algorithm, limits,
  durability, visibility, concurrency), size-limit rejection, and the declared
  error taxonomy instead of engine-specific failures.
- **Single-node concurrency**: in-process threads and separate writer
  processes proposing the same content end with exactly one stored copy and
  zero torn state; distinct contents land under distinct keys.

The run also executes the yijinjing dependency-direction guard
(`src/libyijinjing/check-deps.mjs`) plus its seeded self-test, proving the
ADR-0040 boundary gate catches engine includes, symbols, and CMake links.

Run:

```bash
cmake -S framework/core -B framework/core/build -DKUNGFU_WITH_SLICES=ON
cmake --build framework/core/build --target content_store_probe
node framework/core/slices/content-store/run.mjs
```
