# Storage provider lifecycle: the process-level provider cache

Status: delivered (ADR-0040 decision 6 closure)

ADR-0040 decision 6 states that the per-operation open/close of the storage
provider was a lifecycle artifact, not an engine limit: RocksDB is thread-safe
through a single long-lived handle, so within a process repeated open/close is
removed by holding one handle owned by one provider instance. This document
records how the runtime storage service implements that, and the semantics a
caller may rely on. The implementation lives in
`src/libkungfu/src/runtime/storage/service.cpp` (`provider_cache`).

## What is cached, and under which key

- One `storage_provider` instance per **(provider name, canonical runtime
  dir)** within a process. The runtime dir is canonicalized
  (`fs::absolute(...).lexically_normal()`) before it becomes part of the key,
  so different spellings of the same directory share one instance and one
  engine handle, and distinct runtime dirs never share a handle.
- Every service entry point uses the cache: the operations routed through
  `run_storage_service_operation`, the manifest/payload helpers
  (`accept_storage_manifest`, `load_storage_latest_manifest`,
  `export_storage_records`, `write_storage_payload_bytes`), and the five
  content-store facade functions (`put_if_absent` / `has` / `verify` / `get` /
  `capabilities`). No hot path constructs a provider per call.

## Close and eviction semantics

- **Entries live until process exit.** There is no eviction, no LRU, no
  explicit close operation, and no background maintenance thread. Rationale:
  the set of (runtime dir, provider) pairs a process touches is small; an
  evicted-then-reopened engine handle would reintroduce exactly the open/close
  races the cache removes; and a maintenance thread is out of scope by design.
- **The cache is intentionally leaked at exit** (its destructor never runs):
  destroying a RocksDB handle during static teardown aborts the process once
  the engine's lock infrastructure is torn down first. Exit-without-close is
  safe under the declared contract — publication is WAL-ordered, so it is
  exactly the crash-safety case the backend already commits to.
- Consequently the RocksDB write handle, once opened, **holds the engine lock
  for the rest of the process lifetime**. This is intentional: ADR-0040
  decision 6 requires multi-process ownership of one database path to be
  rejected or explicitly service-fronted. A second process opening the same
  database for write fails with the engine's own lock error — that rejection
  is the contract, not an accident.

## Handle semantics inside the cached RocksDB provider

- The engine handle opens lazily and is shared: operations borrow a
  `shared_ptr` to the handle, so a concurrent readonly-to-readwrite upgrade
  swaps in a fresh handle while in-flight readers finish safely on the old one
  (a readonly open holds no engine lock).
- **Readonly operations never create the database; writes do.** This preserves
  the pre-cache behavior: `fsck`/`status` on an empty runtime dir do not
  materialize an engine directory, while the first write creates it
  (`create_if_missing` only on write opens).
- RocksDB is thread-safe through the shared handle, so N threads calling
  `put_if_absent` concurrently against one runtime dir all succeed with
  exactly one stored copy; identical-bytes races on the same key are benign
  under content identity.
- The file provider is stateless per operation (atomic tmp+rename publishes);
  caching it unifies lifecycle observability without changing its semantics.

## Not the same database as the location metadata engine

`reactor`'s coordinator/app RocksDB (location metadata) lives under the locator's
`layout::MAP` directory (`<root>/map/<role>/<namespace>/<name>/<mode>`); the
storage provider's engine lives under `<runtime_dir>/storage/rocksdb`. The
paths are disjoint by construction, so no database path ever has two in-process
owners. If a future change makes these paths overlap, the overlapping engine
must be unified into the provider cache — two handles on one path within a
process is a defect, not a tuning choice.

## Observability

- `provider.runtime()` reports `instance_lifecycle: "process-cached"` plus the
  live handle state (`closed` / `open-readonly` / `open-readwrite`).
- The `status` and `layout` operations report `provider_cache`
  (`lifecycle` / `entries` / `hits` / `misses`), so cache behavior is
  inspectable without a monitoring stack.
- The Python facade releases the GIL around the C++ call, so Python threads
  genuinely exercise the shared handle; the concurrency fixtures in
  `tests/python/test_content_store_facade.py` prove the dedup guarantee
  through both providers.
