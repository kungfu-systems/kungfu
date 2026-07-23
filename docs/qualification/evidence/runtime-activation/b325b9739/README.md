# Runtime activation product evidence at `b325b9739`

This directory retains the complete machine report and compressed raw suite
logs from the clean-source Darwin arm64 execution at revision
`b325b97392e6253de11e4b7e61b40b9e2fc639ce` and tree
`1076f009258781abf5bbea97ffc4b5576caaf1fb`.

The exact command was:

```sh
./shifu runtime:qualify -- --mode execute --with-product \
  --retain docs/qualification/evidence/runtime-activation/b325b9739
```

The report passed all eight required suites. The `product-verification` suite
includes the passing full product verification run, and the adjacent gzip
bundle preserves one checksummed NDJSON member for every suite log.

| Evidence | SHA-256 | Bytes |
| --- | --- | ---: |
| `report.json` | `5dc35b8ef690f8447fb0e15dfa8e382bbcf05c1645aae73f3303c696d16df804` | 8,432 |
| `raw-logs.jsonl.gz` | `7a6fc31d7edbe1183cd72fb3c7e90a9bde2fee38a8c99fcaf29158daf49bf6eb` | 101,679 |

## Claim boundary

This report supports the process-host, named-platform statement in the
[qualification contract](../../../runtime-activation-and-product-delivery.md).
It does not qualify a production `EmbeddedRuntimeHost`, distributed election,
cross-machine leases, HA, physical-host power loss, default-on production
durability/projection candidates, a universal latency SLO, interactive GUI
pixels, or Linux/Windows products.
