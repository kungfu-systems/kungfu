# Layer-complete product release qualification

This is the operational qualification contract for
[KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff](../adr/KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff.md).
It explains what Kungfu can prove about independently adoptable product layers,
which Shifu Gates own that proof, and where a release claim must still stop.

## What the seven rows mean

The publication verdict has seven independently qualified rows:

| Row | User closure | Exact evidence before publication |
| --- | --- | --- |
| format specification | inspect and preserve `.kungfu` without a product runtime | packed portable specification plus format qualification report |
| Python SDK | use the storage semantics from Python without sibling SDKs or Electron | exact wheel, clean install, shared semantic fixture, deletion proof, six budgets |
| npm SDK | use the same semantics from Node without Python, Rust, or Electron | exact npm archive, clean install, shared semantic fixture, deletion proof, six budgets |
| Cargo SDK | use the same semantics from Rust without Python, Node, or Electron | exact crate, clean install, shared semantic fixture, deletion proof, six budgets |
| CLI/TUI | operate headlessly without Electron | exact archive, capability and workflow smoke, independence, six budgets |
| GUI | complete supported human workflows over public lower contracts | exact desktop bundle and installer, workflow smoke, uninstall proof, six budgets |
| assembled distribution | install compatible official layers together | exact distribution artifact, compatibility manifest, uninstall proof, six budgets |

`libkungfu` is the authority-bearing native closure below these delivery rows.
Its C ABI and native qualification are prerequisites to the layer contract; it
is not replaced by an ecosystem package or counted twice as a publication row.

The six budgets are dependency count, installed size, cold start, resident
runtime count, resident memory, and onboarding concept count. A value marked
unknown or unverifiable cannot pass the release verdict.

## The Gate chain

The checked-in [Gate registry](../../shifu.gates.json) is the source of truth:

```text
layers.contract
  -> layers.format
  -> layers.sdk
  -> layers.surfaces

three platform report sets + immutable public coordinates
  -> layers.release
```

- `alpha-pr` and `release-pr` require `layers.contract`, `layers.format`,
  `layers.sdk`, and `layers.surfaces`. Buildchain schedules the three platform
  legs; `scripts/run-release-qualification.mjs` enters the three artifact Gates
  through Shifu and retains one source-bound Gate receipt per leg.
- `release-promotion` requires `layers.release`. The manual publication workflow
  binds this Gate only after exact artifacts have been published and the public
  registries can be queried.
- Dev profiles intentionally leave these heavy Gates off. This keeps normal dev
  source checks distinct from release-artifact proof.

An explicit `gate run GATE...` receipt proves the named execution and evidence
pointers, but is diagnostic rather than standalone promotion authorization.
Profile policy plus the checked-in workflow bindings determine required remote
coverage. A receipt never publishes, tags, signs, or promotes an artifact.

## Evidence and fail-closed rules

Each artifact Gate writes both a structured qualification report and required
task-specific evidence. Shifu embeds those safe repository-relative pointers
and SHA-256 digests in its unified source-bound receipt. The final Gate:

1. recursively discovers the canonical format, SDK, and surface report names
   from the downloaded three-host evidence root;
2. rejects divergent copies of the portable format report;
3. rejects missing or duplicate platform reports, dirty or mismatched source
   commits, missing artifacts, non-numeric budgets, and absent GUI/product
   installer-uninstall proof;
4. binds every qualified artifact digest to an external HTTPS publication
   coordinate at the exact release version; and
5. emits one seven-row release report plus its Gate evidence and receipt.

The final report cannot turn a source-built archive into a publication claim.
It requires live registry/release evidence produced after publication.

## Current maturity and evidence boundary

The KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff implementation and qualification harness are merged on `dev` via
[PR #797](https://github.com/kungfu-systems/kungfu/pull/797), including the
native closure, SDK and product artifact harnesses, deletion/independence
checks, six-budget measurements, and the fail-closed seven-row aggregator. The
artifact Gates, profile decisions, evidence receipts, workflow bindings, and
this documentation are the control-plane closure of that implementation.

This repository now contains the code needed for three-platform artifact
qualification and post-publication aggregation. This change was validated with
local unit, registry, catalog, planning, and documentation checks; it did not
dispatch the modified GitHub workflows or perform a publication. Therefore:

- the architecture, harness, Gate policy, and receipt contracts are implemented;
- prior source-built platform qualification does not by itself claim a current
  public release;
- no npm, PyPI, crates.io, GitHub Release, alpha, signing, or stable-compatibility
  claim follows from this document; and
- `layers.release` can pass only after a separately authorized real publication
  provides immutable public coordinates.

## Maintainer checks

Use these dependency-light checks to review policy without running a heavy
artifact build:

```sh
./shifu gate validate --json
./shifu gate plan alpha-pr --platform linux --json
./shifu gate plan release-promotion --platform linux --json
./shifu check:gate-catalog
```

The implementation runners and fixtures are documented in
[`tests/qualification/layers/README.md`](../../tests/qualification/layers/README.md).
The generated profile matrix and current workflow ownership are documented in
the [Kungfu Gate catalog](gates/README.md).
