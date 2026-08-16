# Exit, migration, and version compatibility

Kungfu treats the ability to leave, move, and upgrade as part of the product
contract. A compatibility claim is valid only when an installed reader names the
protocol it understands and retained evidence qualifies the exact artifact and
platform. Product version numbers alone are not proof.

## The short answer

| Question | Public commitment |
| --- | --- |
| Will two qualified stable releases on the same `major.minor` line preserve meaning? | **Yes, for registered authoritative semantics.** Roots, full/thin closure, omission and loss, supported protocol interpretation, fail-closed behavior, and success-receipt meaning do not change. |
| Does that mean every file and implementation detail is identical? | **No.** Provider paths, physical layout, derived SQLite files, GUI caches, performance, logs, and presentation may change. |
| Does the promise apply to the current v4 alpha? | **No.** Pre-release compatibility is exact-evidence-only until the first stable v4 line opens. |
| Can a newer minor read every older minor? | **Only when it explicitly declares the historical protocol or a qualified migration exists.** The prior-minor count and duration are not frozen yet. |
| Can a major release break the contract? | **Only with a documented and qualified reader, export, or migration path for data from every still-supported qualified stable line.** Unknown majors fail closed. |

The machine authority for these statements is
[`kungfu-exit-bundle.contract.json`](../../framework/exit/kungfu-exit-bundle.contract.json),
under `supportPolicy`.

## What “same semantics” means

The same-minor promise begins with a qualified stable release and covers the
registered authority that determines whether data is the same and whether an
operation succeeded:

- portable identities and Root preimages;
- full versus thin closure and structured omission or loss;
- interpretation of every supported schema and protocol;
- validation, explicit execution, postflight, and Receipt success semantics;
- fail-closed handling of unsupported required material.

An implementation can change inside the same stable minor only when those
claims remain true. For example, Kungfu may rebuild a derived projection using a
different storage engine, but it may not silently reinterpret an authoritative
Fact, call a thin package complete, or issue success before postflight
equivalence.

The promise does not make these items portable identity:

- provider directories or physical paths;
- copied SQLite projections or GUI caches;
- performance, logging, command prose, or presentation;
- capabilities absent from the installed artifact and its qualification
  evidence.

This boundary lets Kungfu improve implementation and presentation without
changing the meaning users rely on.

## Product versions and protocol versions are different coordinates

Kungfu uses product SemVer to classify changes to registered welded surfaces.
Exit packages and their members also carry explicit schemas and protocols.
Compatibility requires both coordinates:

1. the product release must be inside its declared support policy;
2. the installed verifier must list the package, manifest, and member protocols;
3. the artifact and platform must match retained qualification evidence for any
   released claim.

A matching product minor cannot override an unsupported protocol. Likewise, a
newer product can read an older protocol only when its installed reader
explicitly declares that protocol. Unknown top-level majors and unknown required
member protocols fail before execution.

When identity changes, a successor contract uses a new schema or protocol and
produces an explicit mapping Receipt. Kungfu does not rewrite the old Root and
call it unchanged.

## Inspect the policy shipped with your artifact

The packaged verifier reports the product version, exact contract roots,
supported protocol inventory, support policy, qualification boundary, and
non-claims without initializing or mutating a runtime:

```console
kungfu exit verify --info --json
```

Check these fields:

- `product.version` and `product.channel`;
- `exitContract.contractRoot` and `exitContract.manifestSchemaRoot`;
- `supportedPackageSchemas`, `supportedManifestSchemas`, and
  `supportedMemberProtocols`;
- `supportPolicy.productVersioning`;
- `qualification.overallReleaseStatus`, `retainedEvidence`,
  `unqualifiedPlatforms`, and `nonClaims`.

Installed discovery is not self-qualification. A released support claim still
requires an exact match between the published artifact digest, platform, and
retained release evidence.

## Current v4 pre-release boundary

The current source line is `4.0.0-alpha.3`, so the stable same-minor promise has
not started. Two retained qualification slices currently name the same exact
official `darwin-arm64` CLI archive:

| Slice | Exact artifact digest | What it qualifies |
| --- | --- | --- |
| [Clean-runtime Exit qualification](../qualification/evidence/exit-clean-runtime/520a61af87/report.json) | `sha256:8c0fcb6ec811c03c11be56b6d10fdd7cea5aed50657bc50979cfcdc805fd5cd3` | Full/thin verification, empty-destination import, projection rebuild, bounded continuation, and fail-closed faults |
| [Provider migration qualification](../qualification/evidence/provider-migration-product/bb6f4a42c1/report.json) | `sha256:8c0fcb6ec811c03c11be56b6d10fdd7cea5aed50657bc50979cfcdc805fd5cd3` | Single-host File↔RocksDB copy, verify, atomic binding, resume, rollback, and concurrent-write fence |

These slices do not qualify a stable v4 release. They also do not qualify:

- Linux or Windows release artifacts;
- GUI or TUI Exit and migration parity;
- cross-machine migration or distributed writer fencing;
- destructive source cleanup;
- physical-media durability;
- a fixed count of prior minors or a support duration.

## The public support policy

Kungfu makes four bounded commitments:

1. **Users keep the declared authority.** A full Exit package is closed for its
   declared scope; a thin package exposes its missing material and cannot claim
   continuation.
2. **Stable same-minor meaning does not drift.** Registered authoritative
   semantics remain unchanged across qualified stable patch releases on one
   `major.minor` line.
3. **Compatibility claims are evidence-backed.** Product SemVer, explicit
   protocol inventory, exact artifact digest, platform, and retained evidence
   must agree.
4. **A supported breaking release cannot strand supported qualified stable
   data.** It must provide a documented and qualified reader, export, or
   migration path before publication.

The first stable v4 release must additionally freeze a concrete prior-minor
count or support duration and bind it to exact reader or migration evidence.
Until that decision is published, Kungfu makes no blanket cross-minor window
claim.

## Before upgrading or leaving

1. Read the installed policy with `kungfu exit verify --info --json`.
2. Confirm the target reader lists every required package and member protocol.
3. Build a full package when continuation or materialization is required; a thin
   package is inventory-only.
4. Verify before import. Import validates by default and mutates only with an
   explicit execute action.
5. Retain the package, verification report, import Receipt, product version,
   contract roots, and artifact qualification evidence together.

For runtime activation and rollback boundaries, continue with
[Upgrade Kungfu](upgrading.md). For the exact verification contract and maturity,
see [Contracts](../qualification/contracts.md) and
[Known Limits](../qualification/known-limits.md).
