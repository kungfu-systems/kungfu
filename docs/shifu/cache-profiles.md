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
`cargo.source.crates-io` and `conan.remote.conancenter` config keys create
child-scoped overlays without modifying persistent Cargo/Conan configuration.
Cargo is invoked through a temporary PATH wrapper that supplies highest-priority
`--config` source replacement values; Cargo may still perform its normal
hierarchical config discovery, but the managed source alias and endpoint are
overridden by the profile. Conan receives a disposable `CONAN_HOME` containing
only the managed remote plus an explicitly declared development fallback, if
any; Kungfu detects a default compiler profile inside that isolated home. Both
temporary overlays are removed after the child exits, including non-zero exits.
The nested libwasm Cargo invocation inherits the same wrapper.
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
application when it re-enters `./shifu`. Cache/configuration/bootstrap control
verbs remain direct, and an explicit `./shifu cache apply -- COMMAND` remains
available for overrides and diagnosis.

For CI, Buildchain accepts only the opaque reference and digest and forwards
them to lifecycle commands. It does not fetch or parse the profile. The
consumer lifecycle may continue to invoke `shifu cache apply` explicitly; the
cache control verb and active-child fuse prevent double application. The pinned
Shifu checkout remains the only component that interprets fields and writes the
receipt.
