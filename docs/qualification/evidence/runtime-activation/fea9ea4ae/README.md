# Runtime activation product evidence at `fea9ea4ae`

This directory retains the complete machine report from the clean-source
Darwin arm64 execution at revision
`fea9ea4ae8b7fd57ed1ac0616403c91d91070033` and tree
`0f7e7367e96b1dea698de25c2672931bb257cd69`.

The exact command was:

```sh
./shifu runtime:qualify -- --mode execute --with-product
```

The report passed all eight required suites: activation Core, Profile action
admission, runtime-surface parity, bounded performance, product distribution,
frozen-product runtime smoke, full product verification, and the local product
catalog. `product-verification` contains a passing `82/82` full verification
run with the app artifact and sanitizer corpus. The run registered product
artifact `20260714T102912Z-fea9ea4ae`.

| Evidence | SHA-256 |
|---|---|
| `report.json` | `e2992dfb9d45708a0693f71a3766dd944392df35dc078adc217a28e8e60bad11` |

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
