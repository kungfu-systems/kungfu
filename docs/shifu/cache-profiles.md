# Shifu cache profiles

A cache profile is a generated, secret-free instruction set for one principal,
host class, and execution scope. It is an instance of the
[profile schema](schema/cache-profile-v1.schema.json); this document does not
repeat the schema fields.

## One contract, multiple projections

```text
private inventory
      |
      | generate + validate against Shifu schema
      v
principal/host profile
      |
      | approved projection
      v
local development config or trusted runner input
      |
      | Shifu resolves bindings and records a redacted receipt
      v
task execution
```

The inventory controller owns endpoint availability, topology, and assignment.
Shifu owns the profile and resolution contracts. A host consumes a projection;
it does not become a second authority. Buildchain may select the runner and pass
a trusted profile reference, but it does not reinterpret profile fields.

## Development and runner policy

The examples show two policy shapes without prescribing private infrastructure:

- [`development.cache-profile.json`](examples/development.cache-profile.json)
  prefers caches and allows declared upstream fallback.
- [`self-hosted-runner.cache-profile.json`](examples/self-hosted-runner.cache-profile.json)
  requires selected caches and fails before expensive work when they are
  unavailable.
- [`cache-resolution.json`](examples/cache-resolution.json) shows the redacted
  receipt shape.

The schema, not these examples, decides validity. Examples use the reserved
`.invalid` domain and contain no live service coordinates.

## Security and trust

Profiles never carry credential values. Authentication remains in the
tool/provider's approved secret surface, while the profile may only select
non-secret bindings. HTTP endpoints reject user information, query strings, and
fragments so a token cannot be smuggled into the URL. Resolution evidence uses
the redaction rule declared by the contract and hashes local paths instead of
publishing them.
URL validation preserves whether an origin-only endpoint omitted its trailing
slash, so consumers that append an absolute package path do not receive a
different double-slash request target.

Mirrors accelerate transport; they do not replace upstream integrity. Each
service declares the applicable verification method. A `none` declaration must
carry a rationale and is visible in review.

## Compatibility

Compatibility is defined once in
[`cache-contract.json`](cache-contract.json). Consumers identify the contract by
its `schema` value and major version, reject unknown fields, and fail closed on
an unsupported major version. New mandatory fields or changed meanings require
a new major schema rather than silent reinterpretation. Resolution evidence
binds the SHA-256 of the exact source profile bytes, avoiding an implicit second
canonical JSON renderer.

## Runtime consumption

An inventory controller can pin a local Kungfu checkout or a locally built
Shifu binary, obtain the schema through `shifu cache schema profile`, validate
the generated instance, and project it to an approved local configuration
surface. This makes dogfood independent of npm/alpha publication while keeping
the exact Shifu source revision auditable.

`shifu cache validate profile FILE` runs the Shifu-owned runtime validator.
`shifu cache resolve` loads a local/file/http(s) reference, verifies the digest
of the exact bytes, checks platform and scope applicability, and emits a
schema-versioned redacted receipt. `shifu cache apply -- COMMAND` performs the
same resolution and supplies supported bindings only to that child process.
Environment bindings remain child-only. The reserved
`cargo.source.crates-io`, `conan.remote.conancenter`, and
`conan.cache.storage` config keys create
child-scoped overlays without modifying persistent Cargo/Conan configuration.
Cargo is invoked through a temporary PATH wrapper that supplies highest-priority
`--config` source replacement values; Cargo may still perform its normal
hierarchical config discovery, but the managed source alias and endpoint are
overridden by the profile. Conan receives a disposable `CONAN_HOME` containing
only the managed remote plus an explicitly declared development fallback, if
any. When storage is selected, its `global.conf` keeps mutable package state in
a profile-owned host-local partition under `${SHIFU_CACHE_HOME}`. Each
development worktree and named runner still receives a deterministic writable
partition, so independent checkouts never share one mutable Conan database.
Immutable binary availability is instead owned by the hosted remote and
identified by the full recipe revision, package ID, and package revision.
Conan's content-addressed download cache is shared at the profile namespace
layer, where Conan's own per-content locks coordinate source and package
transport without broadening the mutable-package lock. Worktree-local Core
build and generator folders remain outside both shared artifact layers.

Conan itself is invoked through a temporary PATH wrapper: non-Conan tasks never
take the storage lock, while each real Conan process waits for the same mutable
partition lock for a bounded interval. A lock whose recorded process is no
longer running is reclaimed; an unreadable lock still fails closed. The
persistent partition and shared download artifacts survive the task, while the
temporary policy overlay and on-demand partition lock do not.
Kungfu detects a default compiler profile inside the isolated home. Both
temporary overlays are removed after the child exits, including non-zero exits.
The nested libwasm Cargo invocation inherits the same wrapper.

Checksum-backed recipe sources use ordinary environment bindings. Shifu may
select a mirrored archive URL, but the Conan recipe owns and enforces the same
SHA256 for mirrored and public fallback transport. A receipt records binding
selection and hashed storage identity, never the local cache path.

For a selected Python index, an environment binding alone is insufficient:
frozen uv locks contain exact registry artifact URLs. Shifu therefore copies
each tracked uv project into a disposable overlay,
refreshes the copied lock against `UV_DEFAULT_INDEX`, compares a normalized
dependency semantic digest with the canonical lock, and rejects any effective
registry or artifact URL outside the selected origin. A child-only uv wrapper
routes project commands to that overlay and sets a disposable
`UV_PROJECT_ENVIRONMENT`; the tracked lock, project `.venv`, and checkout remain
untouched. Mutating `uv add`, `uv remove`, and `uv version` commands are rejected
inside this managed execution. The receipt records only lock digests, rebinding
counts, verification state, and cleanup state.
Required profiles fail before the child starts when the endpoint or rebind is
unavailable. Development profiles with an explicit public fallback attempt the
same overlay first, then record a fallback and use the canonical public lock if
tool-native rebinding is unavailable.

Every tracked Kungfu `uv.lock` is a public source artifact and must use
`https://pypi.org/simple` plus `https://files.pythonhosted.org`. The cache
contract gate rejects private, local, alternate, and malformed registry or
artifact hosts. Concrete central endpoints exist only in secret-free projected
profiles and process-private effective locks, never in Git history.
Unsupported argument/config bindings, protected or secret-like environment
keys, unsafe URLs, applicability drift, and digest drift fail closed. Receipts
name binding kinds and overlay cleanup without exposing local paths.

The default reference and digest come from
`SHIFU_CACHE_PROFILE_REF` and `SHIFU_CACHE_PROFILE_DIGEST`. They may also be
passed explicitly:

```sh
./shifu cache apply \
  --profile https://cache.example.invalid/profiles/development.json \
  --digest sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  -- ./shifu check
```

Both values must be present together. When both are absent, `cache apply` is a
transparent pass-through so public clones and forks continue to use normal
upstreams. A local controller may project the pair into the user-global
`build-local.env`; Shifu still resolves the profile at execution time and does
not turn that environment file into another field authority.

When either projected value is visible, the normal `./shifu <task>` entrypoint
automatically enters `cache apply` before running an ordinary task. The resolver
therefore rejects a partial pair instead of silently bypassing policy. The
managed child receives `SHIFU_CACHE_ACTIVE=1`, which prevents recursive
application when it re-enters `./shifu`. `shifu gate run` is an execution verb,
so it enters `cache apply` once before the Gate executor starts and every
task-backed gate inherits the same bindings, disposable configuration, and
exclusive Conan storage lock. Gate contract/schema/plan/receipt inspection and
other cache/configuration/bootstrap control verbs remain direct.

Cache execution context has three states. An absent context follows the
projected profile and may enter `cache apply`; `SHIFU_CACHE_ACTIVE=1` means an
outer Shifu execution already owns the bindings and lock; the internal
`SHIFU_CACHE_BYPASS=source-acceptance` marker means the build-free source gate
is deliberately cache-independent. The bypass never claims that cache was
applied, and only that exact internal value is recognized. Cache profiles
cannot inject either context key. Independent processes still contend for the
exclusive Conan storage lock and fail closed; re-entry only reuses an outer
execution that it actually inherits. An explicit
`./shifu cache apply -- COMMAND` remains available for overrides and diagnosis.

For CI, Buildchain accepts only the opaque reference and digest and forwards
them to lifecycle commands. It does not fetch or parse the profile. The
consumer lifecycle may continue to invoke `shifu cache apply` explicitly; the
cache control verb and active-child fuse prevent double application. The pinned
Shifu checkout remains the only component that interprets fields and writes the
receipt.

Hosted binary publication is an administrative Shifu execution, not a
Buildchain lifecycle input. `scripts/shifu-conan-publish.mjs` provides a
dry-run-first matrix for Mac arm64, Linux GCC 14 x64, and Windows MSVC x64. The
execute path must run inside one `shifu cache apply`, detects and validates the
ephemeral Conan profile, resolves the complete pinned Core dependency closure
with C++23, disables Conan's global compatibility plugin only in that
disposable qualification `CONAN_HOME`, and derives each dependency's full
RREV/package_id/PREV plus effective settings/options from the Conan graph. This
strict path therefore publishes the requested package ID instead of silently
substituting (for example) a `gnu17` package that Conan considers compatible
with a C++23 consumer. It queries the hosted remote first, authenticates with Conan's
remote-scoped environment variables, uploads only missing exact revisions
without `--force`, and reads every revision back. It then resolves the remote's
current PREV for each RREV/package_id, so an older partition-local PREV cannot
define the published closure. The publisher emits a Conan lockfile that pins
dependency RREVs; the receipt binds both that lockfile and the remote-current
RREV/package_id/PREV closure with digests. The `macos-arm64` entry is explicitly bound to Macos armv8,
Apple Clang 21, and C++23.
Publisher credentials remain in the operator or CI secret surface and are
never added to the cache profile, Buildchain arguments, or Shifu receipt.

Ordinary `./shifu build:core` retains Conan's normal compatibility behavior;
the strict override is qualification-local and does not alter persistent user
configuration. Normal runtime evidence must therefore distinguish requested
settings from each resolved binary's effective settings and package ID.

```sh
node scripts/shifu-conan-publish.mjs --matrix-entry macos-arm64 --lockfile-file <publish-lockfile> --receipt-file <publish-receipt>
node scripts/shifu-conan-publish.mjs --matrix-entry linux-gcc14-x64
node scripts/shifu-conan-publish.mjs --matrix-entry windows-msvc-x64
```

The inventory controller owns host routing and the approval to add `--execute`;
normal builds consume the hosted repository anonymously and never receive the
publisher identity.

A cache hit is qualified separately from publication. Run the dry-run in the
source worktree, then execute only in a fresh canonical worktree whose mutable
package partition is empty:

```sh
node scripts/shifu-conan-hit-evidence.mjs --matrix-entry macos-arm64 --publish-lockfile <publish-lockfile> --publish-receipt <publish-receipt>
```

The execute path applies the same qualification-local compatibility override,
uses `--build=never`, and accepts only dependency graph nodes whose binary
state is `Download` from the selected hosted remote. It also requires exact-set
equality with the same-source publisher receipt and verifies its closure
digest. It consumes the digest-bound publisher lockfile so remote revision
ordering cannot select a different RREV before equality is checked. Its
evidence lists every exact RREV/package_id/PREV, effective
settings/options, and an empty source-build set. A warm
worktree-local `framework/core/build` directory or a pre-populated partition is
rejected as hit proof.

Legacy `development-*` partitions are user data. Their operator surface is
read-only by default and reads Conan's SQLite index with a read-only database
handle; it never imports persistent user configuration or reads package bodies:

```sh
node scripts/shifu-conan-legacy.mjs inventory --storage-root <profile-storage-root>
node scripts/shifu-conan-legacy.mjs migrate --storage-root <profile-storage-root>
```

The inventory reports count, byte size, age, lock state, reference summaries,
exact identity confidence, and migration eligibility. Migration planning skips
live, stale, unreadable, corrupt, empty, identity-ambiguous, and
snapshot-vanished partitions. It also skips legacy download, build, and
generator directories because their
paths do not prove Conan package identity. The plan emits an approval digest
and an exact follow-up command. The digest binds the remote, storage root,
eligible partition, and exact RREV/package_id/PREV set while ignoring newly
created empty mutable partitions. Execution additionally requires that digest,
the Shifu-managed publisher environment, a clean checkout, and an exclusive
partition lock. While that lock is held, the migration invokes Conan from the
original tool PATH instead of recursively entering the managed per-command
wrapper lock; it performs only additive exact uploads and readback. It never
deletes, overwrites, links, moves, or compacts legacy artifacts.
Partition roots, `packages`, the SQLite index, and indexed artifact paths must
all be real in-root objects rather than symlinks. Execution fingerprints the
partition and package directory before and around every remote operation,
fails if either changes, and releases its owned temporary lock on normal exit
or termination signals.

## Developer operations

Shifu exposes one local diagnostic surface without taking ownership of central
cache infrastructure:

```sh
./shifu cache status --json
./shifu cache doctor --json
./shifu cache doctor --json --probe
```

`status` reads only the local projection and resolution receipt. It performs no
network I/O. `doctor` resolves the pinned profile and verifies its digest;
`--probe` additionally performs bounded HTTP `HEAD` checks. Each HTTP service
may declare `verification.probe.path`, `timeoutMs`, `attempts`, and
`retryDelayMs`; the path is same-origin and attempts are capped at three.
Without an explicit policy, Shifu makes two attempts and uses the command
timeout, except that Python indexes receive a five-second floor. A devpi
`/<user>/<index>/+simple/` endpoint is probed through its lightweight `+api`
root instead of downloading or waiting on the package index listing. Only
timeouts, transport failures, and HTTP 5xx responses are retried; a persistent
failure remains `degraded`. Probe evidence records target class, timeout,
attempt count, status, and duration without recording the endpoint URL.
Diagnostics keep
`configured`, `resolved`, `reachable`, `effective`, and `hit` separate. A
successful resolution receipt proves selected bindings, not a provider cache
hit, so `hit` remains `unproven` without provider evidence.

Developers outside an inventory-controller projection can manage a bounded
block in the user-global config:

```sh
./shifu cache use --profile path/to/profile.json --digest sha256:...
./shifu cache use --profile path/to/profile.json --digest sha256:... --execute
./shifu cache unset
./shifu cache unset --execute
```

Both commands are dry-run by default. `--execute` writes or removes only the
block delimited by `# shifu-cache-profile begin/end`, preserves unrelated
content, creates a backup before replacing an existing file, and returns a
redacted plan/receipt. `cache use` refuses to overwrite a controller-managed
Atlas block. Central warming, purge, garbage collection, endpoint assignment,
and host rollout remain inventory-controller operations.
