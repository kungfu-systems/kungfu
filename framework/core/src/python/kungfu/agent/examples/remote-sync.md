# Remote Sync Example

Remote sync is planned as a stable product surface. Until a concrete installed
command exists, use local exports and explicit provenance.

```sh
kungfu rewind export <run-id> --out ./rewind-bundle
kungfu work artifact <work-id> --path ./rewind-bundle --json
```

When moving evidence across machines, keep source runtime, export time, bundle
hash, and receiving runtime separate. Do not treat remote availability as proof
that the local runtime observed the fact.
