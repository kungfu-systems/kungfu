# Kungfu Gate catalog

Kungfu uses the project-neutral [Shifu Gate control plane](../../shifu/gates.md)
to register, explain, plan, and execute quality and release gates. The canonical
machine source is [`shifu.gates.json`](../../../shifu.gates.json); this section
explains Kungfu's current policy and does not redefine Shifu semantics.

## Authority and current-state boundary

- Shifu owns the registry, plan, execution, and receipt contracts.
- Kungfu owns the 34 concrete gate ids, actions, documentation, and five policy
  profiles.
- [Workflow bindings](workflow-bindings.json) record how current GitHub
  workflows activate profiles and gates while migration is incomplete.
- Buildchain owns runner allocation and aggregate checks; it cannot weaken a
  Kungfu profile or mint missing Gate receipts.
- `required` means blocking when the workflow activation condition matches.
  Path filters, same-repository restrictions, schedules, and post-merge events
  remain explicit in workflow bindings rather than being hidden in the matrix.
- A gate marked `off` may already have an independent Shifu task. It is
  catalogued for discoverability but is not currently a release requirement.

## Policy profiles

| Profile | Current entry |
| --- | --- |
| `dev-pr` | GitHub-hosted build-free source, governance, docs-path, and Shifu-path checks |
| `dev-patrol` | daily Linux self-hosted full product verify plus advisory external links |
| `alpha-pr` | three-platform self-hosted build/verify/fuzz/release evidence plus conditional membrane and Shifu matrices |
| `release-pr` | currently the same qualification strength as alpha, with the release publication channel |
| `release-promotion` | post-merge promotion rehearsal and Buildchain artifact/passport admission |

See the [generated policy matrix](policy-matrix.md) and the detailed gate
documents:

- [Source, documentation, and governance gates](source-and-governance.md)
- [Product build and runtime gates](build-and-runtime.md)
- [Native and qualification gates](native-qualification.md)
- [Release and promotion gates](release-and-promotion.md)

## Operator commands

```sh
./shifu gate validate
./shifu gate list
./shifu gate matrix
./shifu gate explain product.verify-fuzz --profile alpha-pr
./shifu gate plan alpha-pr --platform linux
./shifu gate run source.acceptance --receipt build/gate-receipts/source.json
./shifu check:gate-catalog
```

Explicit `gate run GATE` is diagnostic and non-qualifying. A qualifying receipt
requires a clean full-profile run. Handler actions such as DCO, Buildchain
configuration, and artifact admission are remote controller boundaries until
the Buildchain orchestration stage registers their handlers.

## Change process

1. Change `shifu.gates.json` first.
2. Update the gate's detailed section and workflow binding if reality changed.
3. Regenerate the matrix with the catalog checker write mode.
4. Run `./shifu check:gate-catalog` and `./shifu check:source`.
5. Treat policy-strength changes as rollout decisions, not documentation edits.

The catalog meta gate checks schema and semantic validity, task existence,
documentation anchors and required fields, the generated matrix bytes, workflow
snippets, and profile coverage. It proves structural consistency, not that a
prose explanation is semantically wise.
