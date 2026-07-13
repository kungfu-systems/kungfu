# Kungfu Gate catalog

Kungfu uses the project-neutral [Shifu Gate control plane](../../shifu/gates.md)
to register, explain, plan, and execute quality and release gates. The canonical
machine source is [`shifu.gates.json`](../../../shifu.gates.json); this section
explains Kungfu's current policy and does not redefine Shifu semantics.

## Authority and current-state boundary

- Shifu owns the registry, plan, execution, and receipt contracts.
- Kungfu owns the 34 concrete gate ids, actions, documentation, and five remote
  policy profiles.
- [Workflow bindings](workflow-bindings.json) record how current GitHub
  workflows activate profiles and gates while migration is incomplete.
- Buildchain owns runner allocation and aggregate checks; the standing patrol
  is pinned to the immutable `v2.12.2` release commit
  `0d5487b64cc4df52519e4b30492876f3819b9137`. Buildchain cannot weaken a
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
| `dev-patrol` | daily or manual three-platform self-hosted full product verify plus advisory external links |
| `alpha-pr` | three-platform self-hosted build/verify/fuzz/release evidence plus conditional membrane and Shifu matrices |
| `release-pr` | currently the same qualification strength as alpha, with the release publication channel |
| `release-promotion` | post-merge promotion rehearsal and Buildchain artifact/passport admission |

`local-changed` is intentionally not a qualifying profile. Local diagnosis uses
`./shifu gate run source.changed-scope` or an explicit list of Gate ids, and the
result is non-qualifying by contract. Keeping it outside the remote profile
matrix prevents a partial changed-file selection from minting a release receipt
or becoming a sixth publication policy by accident.

The matrix is deliberately conservative during rollout. Existing blocking
checks remain `required`; independently runnable heavy Gates without a current
qualification binding remain explicitly `off` instead of being silently
promoted to release requirements. Moving one of those Gates to `advisory` or
`required` is a policy change and must add a workflow binding, current runner
evidence, and a documented failure/rollback decision in the same change.

## Rollout evidence and failure boundary

- Buildchain PR `#1152` introduced the project-neutral profile controller and
  merged to dev as `29a3daaf5417b138683f99a031268afd6efa9afd`.
- Consumer canary run `29245122385` proved deterministic planning but did not
  qualify: Linux and macOS failed, while the restored Windows runner hit an
  Actions acquire-job TLS/session failure. Those outcomes remain failures; no
  receipt or aggregate is rewritten as passing.
- Kungfu PR `#773` published the fail-closed standing patrol on dev after the
  operator explicitly required publication after the Windows attempt,
  regardless of its result.
- Buildchain alpha `v2.12.2-alpha.1` and stable `v2.12.2` were published from
  the exact controller source through protected promotion PRs. The standing
  patrol now consumes the immutable stable release commit above.

The old single-Linux `build.yml@v2-alpha` patrol remains available through Git
history as the rollback implementation. Rollback is a normal reviewed workflow
change; it must not delete the failed canary evidence or claim profile
qualification.

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
