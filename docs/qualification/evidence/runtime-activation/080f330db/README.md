# Runtime activation product evidence at `080f330db`

This directory retains the complete machine report from the clean-source
Darwin arm64 execution at revision
`080f330dbdc6660c7c4c73a10f106469f0a63f86` and tree
`6f5bda9df4848df9b27f9e64f4af3d3db66c960d`.

The exact command was:

```sh
./shifu runtime:qualify -- --mode execute --with-product
```

The report passed all eight required suites: activation Core, Profile action
admission, runtime-surface parity, bounded performance, product distribution,
frozen-product runtime smoke, full product verification, and the local product
catalog. `product-verification` contains a passing `82/82` full verification
run with the app artifact and sanitizer corpus. The run registered product
artifact `20260714T104706Z-080f330db`.

| Evidence | SHA-256 |
|---|---|
| `report.json` | `2d9195177b57feb180e76857ce70936055824e7bc40db079b6b84cad3a44a7e7` |

The adjacent raw suite logs remain local Buildchain output; the retained report
records their individual SHA-256 values so a preserved raw run can be matched
without treating logs as a second authority.

## Claim boundary

This report supports the process-host, named-platform statement in the
[qualification contract](../../../runtime-activation-and-product-delivery.md).
It does not qualify a production `EmbeddedRuntimeHost`, distributed election,
cross-machine leases, HA, physical-host power loss, default-on production
durability/projection candidates, a universal latency SLO, interactive GUI
pixels, or Linux/Windows products.
