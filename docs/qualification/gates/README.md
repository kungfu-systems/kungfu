# Kungfu Gate catalog

Kungfu uses the project-neutral [Shifu Gate control plane](../../shifu/gates.md)
to register, explain, plan, and execute quality and release gates. The canonical
machine source is [`shifu.gates.json`](../../../shifu.gates.json); this section
explains Kungfu's current policy and does not redefine Shifu semantics.

## Authority and current-state boundary

- Shifu owns the registry, plan, execution, and receipt contracts.
- Kungfu owns the 38 concrete gate ids, actions, documentation, five remote
  policy profiles, and one non-policy measurement profile.
- [Workflow bindings](workflow-bindings.json) record how current GitHub
  workflows activate profiles and gates. Schema v2 makes direct Gate,
  Buildchain Gate-profile, and controller entries structure-checked.
- [Closed-world workflow authority](workflow-authority.md) classifies every
  workflow, job, and step, including activation digests, permissions,
  Environment, secret/OIDC surfaces, immutable external refs, publication
  class, and qualifying-receipt authority.
- [Release admission](release-admission.md) binds the current Gate policy to
  Buildchain's sealed capability, runner provenance, control-plane audit,
  exact artifact bytes, freshness, channel, and consumer decision.
- [Measurement coverage](measurement-coverage.md) records the observed
  per-platform `durationMs`, clean source SHA, Gate definition digest, registry
  digest, and retained Shifu receipt for measured Gates.
- Buildchain owns runner allocation and aggregate checks; the standing patrol
  is pinned to the immutable reviewed runtime commit
  `a6145efc210a961da0e5c63d7024d42061550f60`. Buildchain cannot weaken a
  Kungfu profile or mint missing Gate receipts.
- The alpha/release build, source acceptance, and release promotion controllers
  are pinned separately to stable Buildchain `v2.14.1` at
  `bb9ce34b368c6b5a27b00fbdcb0515076abd9744`. Its sealed publication verifier
  transports the complete Gate aggregate into Kungfu's credential-free
  consumer predicate and revalidates the resulting receipt immediately before
  provider mutation. Missing or drifted inputs deny publication rather than
  selecting a legacy path.
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
| `measurement` | manual three-platform source-bound observation of every task-backed Gate; all selected actions are advisory and it never publishes |

The separate `Core build profiles` workflow is an asynchronous diagnostic
observer, not a policy profile or qualifying receipt source. It runs the
`embedded-minimal` and `full` Core profiles on Linux, macOS, and Windows once
per day or on explicit manual dispatch. It deliberately does not run for each
development pull request: optional cross-platform observation must not occupy
GitHub-hosted capacity ahead of the Linux required contexts or extend the dev
merge critical path. Alpha and release qualification continue to require their
declared three-platform Gate profiles; moving this observer off the PR event
does not weaken those policies.

`local-changed` is intentionally not a qualifying profile. Local diagnosis uses
`./shifu gate run source.changed-scope` or an explicit list of Gate ids, and the
result is non-qualifying by contract. Keeping it outside the remote profile
matrix prevents a partial changed-file selection from minting a release receipt
or becoming a sixth publication policy by accident.

`measurement` is likewise not a publication policy. It exists so one manual
workflow can lock a clean source revision, execute every task-backed Gate on
each supported self-hosted platform, and retain the resulting Shifu receipts.
Its three remote handler Gates stay `off`: DCO, Buildchain configuration, and
artifact admission must be observed at their real embedding controllers rather
than replaced by local no-op handlers.

Its workflow binding sets `currentSource: false`: the checker still proves the
profile invocation and full non-`off` Gate set in both directions, but the
one-shot observation runner is not rendered as a Gate's standing policy source.

## Dev required latency SLO

`scripts/measure-dev-required-latency.mjs` is the read-only measurement surface
for the protected development branch. It discovers the required context set
from live branch protection, then measures each merged PR revision from the
earliest matching Actions workflow `created_at` through the first successful
result for every required context no later than the PR merge. This includes
workflow/job queueing and pre-admission retries while excluding post-merge
reruns; runner execution time alone is not the metric.

The report uses the current source planner to classify samples as `native`,
`non-native`, or `unknown`, and reports nearest-rank P50/P95 for every stratum.
Planner failures remain unknown instead of becoming non-native. For each native
sample, the collector reads the final successful affected-native workflow's
retained partition artifacts and validates every Buildchain
dependency/compiler portable cache receipt. It rejects an incomplete or
overlapping partition index set, inconsistent source/plan/coverage digests, or
any target/CTest union that differs from the authoritative plan. It reports
exact/compatible warm reuse, miss/corrupt cold
fallback, unknown evidence, ccache hits, and the aggregate warm/cold ratio;
duration is never used to infer a hit. Non-native samples are explicitly
`not-applicable`. Missing, expired, or malformed artifacts remain `unknown`, and
a window with unknown native cache evidence cannot qualify. Missing or
non-success required contexts are retained as explicit exclusions with their
reason and are never silently removed from the dataset.

New native artifacts also carry Buildchain toolkit observability. The Gate
records source- and plan-bound spans for dependency install, configure, build,
and test, plus a summarized process-tree sample for the compile step and compact
runner/tool/compiler-cache diagnostics. The collector verifies the diagnostics
digest and Gate binding, then reports per-phase P50/P95, warm/cold cohorts, and
requested-versus-observed build concurrency. Older artifacts without this
additive evidence remain visible as unknown attribution; they do not fabricate
phase timings and do not invalidate otherwise complete portable-cache facts.

The current dev objective is queue-inclusive P50 at most 300 seconds and P95 at
most 600 seconds. A report is an observation, not a release credential, and a
small passing sample does not by itself qualify the objective. Rebuild a recent
window only after it contains at least 20 total samples and 10 native samples;
otherwise the machine verdict remains non-qualifying. Rebuild it with:

```sh
./shifu gate:latency:measure --branch dev/v4/v4.0 --limit 30
```

Dev admission is intentionally narrower than asynchronous observation. The
protected branch keeps the three Linux-hosted required contexts as its only
merge-critical set. Daily/manual patrol and Core-profile workflows retain
macOS, Windows, full-profile, and fault evidence without placing those optional
jobs in front of required merge-group work. Alpha and release admission remain
cross-platform and fail closed according to their own matrix rows.

The command requires `unzip` plus a read-only GitHub token through `GH_TOKEN` or
`GITHUB_TOKEN`, or an authenticated `gh` client. It reads pull requests,
workflow/check metadata, changed paths, and branch protection; it does not
modify repository settings or workflow runs.

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

This structured Gate closure is nested inside the broader closed-world
authority manifest. Gate bindings answer which registered Gate/profile/controller
is invoked. Workflow authority separately answers whether every other job and
step is diagnostic, qualifying, product-publication, or channel-control code,
and what credential surface it receives. Both checks must pass.

## Operator commands

```sh
./shifu gate validate
./shifu gate list
./shifu gate matrix
./shifu gate explain product.verify-fuzz --profile alpha-pr
./shifu gate plan alpha-pr --platform linux
./shifu gate run source.acceptance --receipt build/gate-receipts/source.json
./shifu check:gate-catalog
gh workflow run gate-measurement.yml --ref dev/v4/v4.0 -f source-ref=<FULL_SHA>
```

Focused measurements bootstrap from the locked source with the self-hosted
runner's bundled Node.js and do not download external Actions. Each focused job
retains its receipt in the job log. During this diagnostic-only bootstrap, the
catalog may tolerate stale retained evidence only for the explicitly focused
Gate ids, breaking the otherwise circular requirement to measure a changed
definition before its old receipt can be replaced. Every other catalog issue
still fails closed, and ordinary source acceptance has no exemption. Recover
one exact receipt without relying on the Actions artifact service:

```sh
gh run view <RUN_ID> --job <JOB_ID> --log 2>/dev/null \
  | node scripts/recover-focused-gate-receipt.mjs \
      --output docs/qualification/evidence/gate-measurements/<SOURCE>/<PLATFORM>/receipt.json
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
4. Classify every changed workflow/job/step in `workflow-authority.json`, then
   review the generated [authority matrix](workflow-authority.md). A refresh
   records exact YAML but cannot authorize a mutable external ref or elevate a
   publication class.
5. For every new Gate, run the diagnostic Gate on every platform declared by
   `platforms` from one clean source revision and retain each
   `shifu.gate-receipt/v1` JSON under `docs/qualification/evidence/`. The
   matching result must be attempted, passing, exit `0`, and contain the
   current Gate definition digest and measured `durationMs`.
6. Add the receipts and their exact source, registry, duration, and platform
   fields to `measurement-coverage.json`. The frozen adoption baseline cannot
   be expanded; even a new `off` Gate requires measurement coverage.
7. Regenerate the policy and measurement tables with
   `node scripts/check-kungfu-gate-catalog.mjs --write`.
8. Run `./shifu check:gate-catalog` and `./shifu check:source`.
9. Treat policy-strength, credential, and publication-authority changes as
   rollout decisions, not documentation edits.

Measurements are retained observations, not live benchmarks. They do not
change automatically after a later code commit. A Gate definition change makes
its registered definition digest stale and fails the catalog check. An
implementation-only change cannot be inferred from the registry, so the author
must re-run and replace the observations whenever it can materially affect
runtime or expected cost.

The catalog meta gate checks schema and semantic validity, task existence,
documentation anchors and required fields, the generated matrix bytes,
structured direct/profile/controller workflow facts, adapter uniqueness and
input contracts, closed-world workflow authority, sealed release policy,
generated authority documentation, profile coverage, and source-bound
measurement coverage. It
rejects missing platforms, dirty source, failed/skipped results, stale Gate
definitions, mismatched durations, and missing receipts. It proves structural
consistency, not that a prose explanation is semantically wise.
