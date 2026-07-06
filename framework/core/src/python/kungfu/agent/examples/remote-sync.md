# Remote Sync Example

Remote sync mirrors a source runtime into a source-scoped local projection.
It is experimental and does not merge remote facts into local authoritative
truth.

```sh
kungfu remote add ubuntu --host ubuntu.local --home /home/dkr/.kungfu --json
kungfu remote sync ubuntu --json
```

When moving evidence across machines, keep source runtime, export time, bundle
hash when available, and receiving runtime separate. Do not treat remote
availability as proof that the local runtime observed the fact.
