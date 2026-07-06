# Report Mode Example

Use report mode when the useful durable fact is work state, not a captured
process.

```sh
kungfu work create "Inspect failed extension load" --kind investigation --json
kungfu work checkpoint <work-id> --summary "Reproduced with local bundle" --json
kungfu work ready <work-id> --reason "Evidence attached" --json
```

For an external agent run that should not be launched by Kungfu:

```sh
kungfu report run begin --work <work-id> --provider codex --json
kungfu report cost --run <run-id> --provider codex --model gpt-5 --usd 0.42 --json
kungfu report run end --run <run-id> --status succeeded --json
```

Keep facts labeled:

- observed: local command output, local bundle paths, local journal records.
- reported: user description, provider output, remote service response.
- imported: copied bundles or reports from another runtime.
