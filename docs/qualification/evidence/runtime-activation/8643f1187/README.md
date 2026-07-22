# Runtime activation product evidence at `8643f1187`

This directory retains the complete machine report from the clean-source
Darwin arm64 execution at revision
`8643f118713e829dbef441501a0c444258383647` and tree
`d9372b48f07e9677585724366bf746c2123184e1`.

The exact command was:

```sh
./shifu runtime:qualify -- --mode execute --with-product
```

The report passed all eight required suites: activation Core, Profile action
admission, runtime-surface parity, bounded performance, product distribution,
frozen-product runtime smoke, full product verification, and the local product
catalog. `product-verification` contains a passing `82/82` full verification
run with the app artifact and sanitizer corpus. The run registered product
artifact `20260714T113632Z-8643f1187`.

| Evidence | SHA-256 |
|---|---|
| `report.json` | `be98265b8dffa96b45d38496b6dc27560daab88afc844588c74150fc8ff5594f` |

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
