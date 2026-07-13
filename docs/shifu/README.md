# Shifu

Shifu is Kungfu's development and build execution tool. It opens a checkout,
resolves the pinned toolchain, applies local execution policy, and delegates the
declared task. Buildchain owns the build and release process around that
execution; Shifu owns how the task is executed after source checkout.

## Start here

- [Cache profiles](cache-profiles.md) explains how a private inventory projects
  a secret-free profile for development or a self-hosted runner.
- [`cache-contract.json`](cache-contract.json) is the machine-readable contract
  manifest and the discovery root for schema paths, schema IDs, ownership, and
  compatibility rules.
- [`schema/cache-profile-v1.schema.json`](schema/cache-profile-v1.schema.json)
  is the single source of truth for cache profile fields.
- [`schema/cache-resolution-v1.schema.json`](schema/cache-resolution-v1.schema.json)
  is the single source of truth for redacted resolution evidence.
- [`schema/cache-diagnostic-v1.schema.json`](schema/cache-diagnostic-v1.schema.json)
  governs `cache status` and `cache doctor` output.
- [`schema/cache-config-plan-v1.schema.json`](schema/cache-config-plan-v1.schema.json)
  governs dry-run and executed `cache use/unset` receipts.
- [Shifu ADRs](adr/README.md) contain Shifu-specific decisions in an independent
  `SHIFU-ADR-*` namespace.

The checked-out Shifu exposes these sources without requiring a published
package:

```sh
./shifu cache contract
./shifu cache schema profile
./shifu cache schema resolution
./shifu cache schema diagnostic
./shifu cache schema configPlan
./shifu cache validate profile path/to/cache-profile.json
./shifu cache resolve --profile path/to/cache-profile.json --digest sha256:...
./shifu cache apply --profile path/to/cache-profile.json --digest sha256:... -- ./shifu check
./shifu cache status --json
./shifu cache doctor --json [--probe]
./shifu cache use --profile path/to/cache-profile.json --digest sha256:... [--execute]
./shifu cache unset [--execute]
```

The contract and schema discovery commands print the exact checked-in JSON.
Consumers should pin the checkout or binary source revision when they use the
result as a generation input. Runtime commands consume profile instances and
never modify the checked-in contract. `status` is local-only, `doctor` probes
endpoints only when explicitly requested, and local configuration changes are
dry-run unless `--execute` is present.

## Boundary

Shifu profiles are configuration projections, not infrastructure inventories.
Do not commit private endpoint inventories, credentials, organization variables,
or host-specific secrets here. An inventory controller may generate profiles,
validate them against the Shifu schema, and place them in approved local or CI
configuration surfaces.

Phase-0 locked source checkout remains a Buildchain concern. The Shifu cache
contract starts after the checkout is available and covers toolchain,
dependency, artifact, compiler, and generic download caches used during task
execution.
