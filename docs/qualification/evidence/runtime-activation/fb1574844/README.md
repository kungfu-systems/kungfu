# Runtime activation product evidence at `fb1574844`

This directory retains the complete machine report from the clean-source
Darwin arm64 execution at revision
`fb157484432c36345903ea2d64fab301f365b083` and tree
`93197395730b9c474b35143a266318009d22b943`.

The exact command was:

```sh
./shifu runtime:qualify -- --mode execute --with-product
```

The report passed all eight required suites: activation Core, Profile action
admission, runtime-surface parity, bounded performance, product distribution,
frozen-product runtime smoke, full product verification, and the local product
catalog. `product-verification` contains a passing `82/82` full verification
run with the app artifact and sanitizer corpus.

| Evidence | SHA-256 |
|---|---|
| `report.json` | `deb7f424f3d1b9999d085d92df0b407e53bc6b3156d3dddfdfbe01d762c7093c` |

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
