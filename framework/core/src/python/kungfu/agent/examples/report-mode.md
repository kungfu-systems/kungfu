# Report Mode Example

Use report mode when the useful durable fact is work state, not a captured
process.

```sh
kungfu work create "Inspect failed extension load" --kind investigation --json
kungfu work checkpoint <work-id> --summary "Reproduced with local bundle" --json
kungfu work ready <work-id> --reason "Evidence attached" --json
```

Keep facts labeled:

- observed: local command output, local bundle paths, local journal records.
- reported: user description, provider output, remote service response.
- imported: copied bundles or reports from another runtime.
