# Report Mode Example

Use report mode when the useful durable fact is work state, not a captured
process.

```sh
kungfu work capture request.json
kungfu work admit request.json --workspace <path> --actor <actor>
kungfu work status --workspace <path> --initiative-id <initiative-id> --assignment-id <assignment-id>
```

For an external agent run that should not be launched by Kungfu:

```sh
kungfu report run begin --work <work-id> --provider codex --json
kungfu report cost --run <run-id> --provider codex --model gpt-5 --usd 0.42 --json
kungfu report run end --run <run-id> --status succeeded --json
```

For native Work, close the exact Assignment through the canonical Profile
actions:

```sh
kungfu work claim-completion completion.json --workspace <path> --authorized-by <actor>
kungfu work review review.json --workspace <path> --authorized-by <reviewer>
kungfu work decide decision.json --workspace <path> --authorized-by <actor>
```

The returned action receipt, Episode, and Fact are the completion evidence.
Token totals remain observed usage evidence; only report split fields or exact
cost when that attribution is actually known.

Keep facts labeled:

- observed: local command output, local bundle paths, local journal records.
- reported: user description, provider output, remote service response.
- imported: copied bundles or reports from another runtime.
