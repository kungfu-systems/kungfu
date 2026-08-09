# Runtime activation product evidence at `527652f13`

This directory retains the complete machine report from the clean-source
Darwin arm64 execution at revision
`527652f1392359065fe18f8f89f8ad3727bbb202` and tree
`51f8d268a095395d1fb1ff582c7595992b01dcc3`.

The exact command was:

```sh
./shifu runtime:qualify -- --mode execute --with-product
```

The report passed all eight required suites: activation Core, Profile action
admission, runtime-surface parity, bounded performance, product distribution,
frozen-product runtime smoke, full product verification, and the local product
catalog. `product-verification` contains a passing `82/82` full verification
run with the app artifact and sanitizer corpus. The run registered product
artifact `20260714T112358Z-527652f13`.

| Evidence | SHA-256 |
|---|---|
| `report.json` | `ff1cf3a4177704b13d2c1154a3c3981faccaba9de759a57cdedfa45f235ddd3b` |

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
