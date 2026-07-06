# Report Mode Example

Use report mode when the useful durable fact is work state, not a captured
process.

```sh
kungfu work create "Inspect failed extension load" --kind investigation --json
kungfu work checkpoint <work-id> "Reproduced with local bundle"
kungfu work ready <work-id> --reason "Evidence attached" --json
```

For an external agent run that should not be launched by Kungfu:

```sh
kungfu report run begin --work <work-id> --provider codex --json
kungfu report cost --run <run-id> --provider codex --model gpt-5 --usd 0.42 --json
kungfu report run end --run <run-id> --status succeeded --json
```

For a native Codex goal, use the adapter so closeout has one receipt to verify:

```sh
kungfu codex report-goal --goal-id <goal-id> --status succeeded --tokens-used <n> --json
kungfu codex verify-goal-report --receipt <receipt-path> --json
```

`tokens-used` is a native observed total. It is recorded as usage evidence. Only
pass split token fields or `--usd` when that cost attribution is actually known.

Keep facts labeled:

- observed: local command output, local bundle paths, local journal records.
- reported: user description, provider output, remote service response.
- imported: copied bundles or reports from another runtime.
