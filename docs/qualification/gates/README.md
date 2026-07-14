# Kungfu Gate catalog

Kungfu uses the project-neutral [Shifu Gate control plane](../../shifu/gates.md)
to register, explain, plan, and execute quality and release gates. The canonical
machine source is [`shifu.gates.json`](../../../shifu.gates.json); this section
explains Kungfu's current policy and does not redefine Shifu semantics.

## Authority and current-state boundary

- Shifu owns the registry, plan, execution, and receipt contracts.
- Kungfu owns the 38 concrete gate ids, actions, documentation, and five remote
  policy profiles.
- [Workflow bindings](workflow-bindings.json) record how current GitHub
  workflows activate profiles and gates. Schema v2 makes direct Gate,
  Buildchain Gate-profile, and controller entries structure-checked.
- Buildchain owns runner allocation and aggregate checks; the standing patrol
  is pinned to the immutable `v2.12.4` release commit
  `a6145efc210a961da0e5c63d7024d42061550f60`. Buildchain cannot weaken a
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
- Buildchain stable `v2.12.4` was published from the protected release train
  after cross-platform fixture checks, alpha self-dogfood, exact-alpha
  qualification, and the stable candidate patrol. It includes the Windows
  batch adapter, per-run managed receipt cleanup, and human-authority stable
  reconciliation fixes discovered by the first three-runner patrols. The
  standing patrol consumes the immutable stable release commit above.

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

## Bidirectional workflow closure

`./shifu check:gate-catalog` parses every `.github/workflows/*.yml` file as
YAML and projects direct execution into normalized facts containing the
workflow, job, execution kind, profile, and Gate ids. It recognizes both POSIX
`./shifu gate run` and Windows `.\\shifu.cmd gate run` steps, including
multiline scalars, plus the pinned Buildchain `.gate-profile.yml` reusable
workflow with a static `gate-profile` input.

The checker reconciles those facts in both directions:

- every discovered direct Gate or profile invocation must match exactly one
  binding at the same workflow and job;
- every `execution: gate` or `execution: profile` binding must have a real YAML
  invocation, not a comment or unrelated string;
- Gate ids and profile ids must be static registry ids, profile Gate sets must
  equal the non-`off` policy, and every selected Gate must remain non-`off` for
  the binding's declared profiles;
- duplicate ownership, missing execution, unknown or dynamic ids, and
  Gate/profile mismatches fail closed.

Controller bindings use one of three finite adapter kinds:

| Binding | Adapter type | Structured identity |
| --- | --- | --- |
| `dev-source` | `buildchain-source` | Buildchain source reusable workflow plus `mode`, ref, and artifact inputs |
| `all-pr-dco` | `dco-shell` | named run step, base/head environment, and bounded DCO failure-path tokens |
| `channel-buildchain-config` | `buildchain-config` | Buildchain validation action plus version/lifecycle inputs |
| `dev-external-links` | `external-links-action` | immutable Lychee action plus blocking inputs |
| `channel-heavy-build` | `buildchain-heavy-build` | Buildchain build workflow plus runner, verify, publication, cache, and contract inputs |
| `release-admission` | `buildchain-release-admission` | Buildchain promotion workflow plus dependency, artifact, passport, and publish inputs |

The adapter identity is also the reverse-discovery key. Reusing a registered
controller workflow, action, or named run-step elsewhere creates a fact that
must receive its own binding. Removing the declared structure, changing a key
input, registering overlapping ownership, or declaring a controller without an
adapter fails closed. A genuinely new controller identity cannot be inferred
from arbitrary YAML semantics: its first change must add one bounded adapter
type, tests, Gate mapping, and retirement condition. If an entry can use a
normal Shifu Gate or profile, it should do that instead of adding an adapter.

There is no `requiredSnippets` execution proof in schema v2. Static workflow
inspection proves the checked YAML shape, not the internals of an external
reusable workflow or the runtime behavior of a shell body. Immutable
references, contract locks, source-bound receipts, and runtime receipts remain
responsible for that cross-repository evidence.

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
3. Declare the workflow/job execution in `workflow-bindings.json`; direct Gate
   and profile ids must be statically recoverable from YAML, while every
   controller must declare one bounded adapter.
4. Regenerate the matrix with the catalog checker write mode.
5. Run `./shifu check:gate-catalog` and `./shifu check:source`.
6. Treat policy-strength changes as rollout decisions, not documentation edits.

The catalog meta gate checks schema and semantic validity, task existence,
documentation anchors and required fields, the generated matrix bytes,
structured direct/profile/controller workflow facts, adapter uniqueness and
input contracts, and profile coverage. It proves structural consistency, not
that a prose explanation is semantically wise.
