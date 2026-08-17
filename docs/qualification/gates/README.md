# Kungfu Gate catalog

Kungfu uses the project-neutral [Shifu Gate control plane](../../shifu/gates.md)
to register, explain, plan, and execute quality and release gates. The canonical
machine source is [`shifu.gates.json`](../../../shifu.gates.json); this section
explains Kungfu's current policy and does not redefine Shifu semantics.

## Authority and current-state boundary

- Shifu owns the registry, plan, execution, and receipt contracts.
- Kungfu owns the 38 concrete gate ids, actions, documentation, six remote
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
  `9e904de2c85dbea7c799780ee166510b3336d812`. Buildchain cannot weaken a
  Kungfu profile or mint missing Gate receipts.
- The alpha/release build, source acceptance, and release promotion controllers
  are pinned separately to stable Buildchain `v3.0.0` at
  `9e904de2c85dbea7c799780ee166510b3336d812`. Its sealed publication verifier
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
| `dev-pr` | GitHub-hosted build-free source, governance, docs-path, and Linux Shifu-path checks |
| `dev-patrol` | manual exact-source three-platform GitHub-hosted full product verify plus advisory external links |
| `alpha-pr` | four GitHub-hosted full-product lanes, with build/verify/release evidence and conditional membrane and Shifu matrices |
| `release-pr` | currently the same qualification strength as alpha, with the release publication channel |
| `release-promotion` | post-merge promotion rehearsal and Buildchain artifact/passport admission |
| `layer-publication` | post-publication verification of seven immutable public coordinates and exact three-platform evidence |
| `measurement` | manual three-platform source-bound observation of every task-backed Gate; all selected actions are advisory and it never publishes |

The separate `Core build profiles` workflow is an asynchronous diagnostic
observer, not a policy profile or qualifying receipt source. Once per day or
on explicit manual dispatch it runs the `embedded-minimal` and `full` Core
profiles plus the Shifu workspace and Xinfa observations on Linux, macOS, and
Windows. It deliberately does not run for each development pull request:
optional cross-platform observation must not occupy GitHub-hosted capacity
ahead of the Linux required contexts or extend the dev merge critical path.
The dev aggregate still requires the complete Shifu workspace Gate on hosted
Linux when its exact path plan selects it. Alpha and release qualification
continue to require their declared three-platform Gate profiles; moving the
other platform observations off the dev PR event does not weaken those
policies.

The `Dev post-merge advisory` workflow applies the same separation to the two
source-bound observations that previously ran at the tail of every
`affected-native-pr.yml` merge-group run. A successful protected Dev push
locates the exact successful merge-group authority for that merged SHA, then
runs Production Graph parity and, when the exact plan contains a native
closure, the three-platform Qualified Core candidate matrix. Its concurrency
group keeps at most one running execution and GitHub's one latest pending
execution per Dev ref; `cancel-in-progress: false` preserves the already
running exact-source observation while a newer pending push supersedes an
older pending push. Cancelled, superseded, failed, and unqualified outcomes
remain visible in the advisory workflow and its promotion summary. They cannot
relabel or block the merge that already completed.

Qualified Core candidate provenance names the post-merge advisory run and
workflow. Promotion separately revalidates the original merge-group delivery
attempt for the same source instead of presenting the advisory producer as
merge-group authority. The transport remains non-authoritative, and source
build remains the fallback whenever an exact candidate row is absent. Alpha
and release workflows, policy profiles, and qualification requirements are
unchanged.

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
from GitHub's effective branch rules, including rulesets, then measures each
merged PR from its first authoritative `AddedToMergeQueueEvent` through the
latest job completion in the first successful required-context set on the
eventual merged queue round. Required contexts may come from separate workflow
runs only when they bind the same merge-group source. The window includes every
dequeue, retry, and gap after first enqueue. PR-head checks remain diagnostic
only, post-merge reruns are excluded, and runner execution time alone is not the
metric.

The retained baseline must change in the same protected-branch transition as
the live required-context authority. The admitted default dev branch effective rules
require both `Candidate source acceptance / check` and the stable
`affected-native / linux` aggregate. A ruleset change without the matching
baseline transition therefore fails closed before samples are collected.

The report uses the current source planner to classify samples as `native`,
`non-native`, or `unknown`, and reports nearest-rank P50/P95 for every stratum.
Planner failures remain unknown instead of becoming non-native. For each native
sample, the collector reads the source-bound partition artifacts from the
merged queue round's affected-native workflow and validates every Buildchain
dependency/compiler portable cache receipt. The evidence must bind to the exact
merge-group SHA and current planner authority. When GitHub coalesces more than
one PR into the group, the report records `merge-group-coalesced` rather than
pretending that the group plan equals the single-PR plan; the receipt's own
plan/diagnostics/coverage digests still remain exact and self-consistent. The
collector rejects an incomplete or overlapping partition index set,
inconsistent source/plan/coverage digests, or any target/CTest union that
differs from the authoritative group plan. It reports exact/compatible warm
reuse, miss/corrupt cold fallback, unknown evidence, ccache hits, and the
aggregate warm/cold ratio; duration is never used to infer a hit. Non-native
samples are explicitly `not-applicable`. Missing, expired, or malformed
artifacts remain `unknown`, and a window with unknown native cache evidence
cannot qualify. Missing or non-success required contexts are retained as
explicit exclusions with their reason and are never silently removed from the
dataset.

The retained baseline records the last observed window even when it fails the
target. It must not preserve an earlier passing verdict derived from PR-head
workflow timing after the queue-inclusive authority changes. A new optimization
therefore proves itself prospectively; historical slow queue rounds remain
visible until they naturally age out of the exact rolling window.

New native artifacts also carry Buildchain toolkit observability. The Gate
records source- and plan-bound spans for dependency install, configure, build,
and test, plus a summarized process-tree sample for the compile step and compact
runner/tool/compiler-cache diagnostics. The collector verifies the diagnostics
digest and Gate binding, then reports per-phase P50/P95, warm/cold cohorts, and
requested-versus-observed build concurrency. Older artifacts without this
additive evidence remain visible as unknown attribution; they do not fabricate
phase timings and do not invalidate otherwise complete portable-cache facts.

Each qualifying sample also emits a Buildchain
`buildchain.candidate-timeline/v1` projection. The projection correlates PR
admission, every merge-queue round, workflow/job/step provider timing, and the
source-bound internal Core, SDK, wire-language, and native-closure stages. It
keeps PR and queue attempts separate and computes wall-clock critical paths per
attempt; interval unions prevent nested steps or parallel jobs from being
double-counted. Aggregate admission and post-build merge finalization have
separate phases, while skipped or dependency-blocked jobs remain explicit
non-executions without invented timestamps. GitHub still does not expose a job
`queued_at` timestamp, so the report does not claim an exact runner wait.
Instead it records the conservative interval from workflow `created_at` to job
`started_at` as a scheduler-and-dependency wait upper bound, requires complete
job evidence, and applies a 30-minute maximum upper-bound budget. Historical
artifacts without the new internal event stream likewise retain explicit
unknown stages. The compact report ranks actionable spans,
reports execution-lane skew and cache outcomes, and names one falsifiable next
optimization target for a repeat of the same source-bound cohort.

Use repeated `--pull` arguments for exact historical candidates. For a single
candidate, `--timeline-output` writes the standalone machine contract and emits
the compact human report on stderr:

```sh
./shifu gate:latency:measure \
  --repository kungfu-systems/kungfu \
  --pull 1254 \
  --output /tmp/kungfu-pr-1254-latency.json \
  --timeline-output /tmp/kungfu-pr-1254-candidate-timeline.json
```

For a quick required-latency and delivery refresh, `--latency-only` keeps the
same branch-rules, merge-queue event, job, required-window, and source-planner
authority while skipping the large native diagnostic artifact downloads:

```sh
./shifu gate:latency:measure \
  --repository kungfu-systems/kungfu \
  --limit 30 \
  --latency-only \
  --output /tmp/kungfu-dev-latency-only.json
```

This mode marks native cache and attribution evidence `unknown`, leaves the
full `verdict.qualified` fail closed, and sets
`collection.retainedBaselineEligible` to `false`. It is therefore suitable for
monitoring the queue-inclusive SLO and delivery/dequeue window, but it cannot
replace the full artifact-backed command or update the retained baseline.

The same report has a separate merge-queue delivery section. Delivery latency
runs from the first authoritative GitHub `AddedToMergeQueueEvent` through the
PR `merged_at`, with P50/P90 targets of 15/30 minutes. The dequeue cohort also
keeps PRs that have left the queue but have not yet merged: GraphQL
`RemovedFromMergeQueueEvent.reason` supplies the reason, while Core
`merge_group` workflow branches bind Actions runs to the PR and queue round.
This exposes entry/dequeue counts, the separate merge-conflict dequeue rate,
additional Core validations after the first, total job runner time spent on
non-merged rounds, and the portion that continued after dequeue. A validation
repeated once after an authoritative non-merged queue round is attributed to
that dequeue reason; a duplicate of the same workflow inside one queue round
remains unexplained and prevents qualification. Runner time is the sum of job
execution durations, so parallel jobs intentionally represent consumed
runner-minutes rather than wall-clock latency. Qualification requires overall
dequeue below 10%, merge-conflict dequeue below 5%, zero unexplained repeated
validation, and complete runner-wait upper-bound evidence within 30 minutes.

The report also joins exact-head `Dev post-merge advisory` push runs to each
merge commit. Their workflow duration and merge-to-completion tail remain fully
visible in `postMergeAdvisory`, but every advisory event declares
`criticalPathEligible: false` and `mergeCriticalMetricImpact: excluded`.
Neither required Gate latency nor merge-queue delivery percentiles include that
post-merge tail.

The queue cohort covers Core `merge_group` runs created since the oldest PR in
the selected merged-PR window, plus those selected merged PRs themselves. It
also probes non-merged PRs updated during that delivery window, then retains
only candidates with authoritative queue events or incomplete collection. This
keeps a closed PR whose paired enqueue/dequeue attempts produced no
`merge_group` run, while excluding ordinary recent PRs that never entered the
queue. A PR with an open queue round, an unmatched run, missing job evidence, or
a failed API read stays incomplete; it never contributes an invented zero.
Delivery percentiles require completed merges, while dequeue, repeat, and
wasted-runner totals include every completely paired queue round in that
cohort. A completely paired non-merged round with no assigned Actions run has
zero observed runner work; missing event or job evidence remains incomplete.
The delivery objective additionally requires fewer than 10% of queue-observed
PRs to have a non-merged exit and at least 20 completed delivery samples.

`.github/workflows/cancel-dequeued-merge-group.yml` bounds waste after an
authoritative dequeue. Its `pull_request_target: dequeued` job checks out only
the current protected base ref selected by the event's `dev/v*/v*` target,
never the pull-request head. This avoids executing a stale controller when the
event's immutable base SHA predates a recently merged terminal-state fix. The
job grants only the scoped permissions required to cancel Actions runs and
maintain the PR repair marker. The controller selects active
`affected-native-pr.yml` merge-group runs whose queue branch ends in the exact
PR number and cancels each run once. A `409` terminal race is idempotent;
unexpected API or permission failures remain fatal and visible. A `failed_checks`,
`merge_conflict`, or `invalid_merge_commit` removal also upserts one marker
bound to the event's exact PR head. Atlas admission refuses that same head in a
later thread; a corrected head is eligible for a fresh admission. Manual
dequeues do not mint the marker, so a serialized position race can safely
yield and retry. Every non-merged removal revokes the exact-head queue
admission lease. A normal `merged` removal still releases any family lease and
bounds leftover work, but preserves the successful terminal queue-admission
status instead of manufacturing a post-merge failure.

Before expensive pull-request qualification starts, candidate preflight also
replays the pull request's first-parent commit series onto the exact protected
base using the repository's existing rebase-queue admission. The replay writes
only unreachable Git objects and changes no ref, index, or worktree. A
deterministic replay conflict fails preflight, so native, SDK, Shifu, and KFD
jobs do not spend runner time on a source revision that the protected `REBASE`
queue cannot admit. Merge-group candidates have already been synthesized by
the queue and do not repeat this PR-only admission.

The retained `2026-07-27T02:55:08.491Z` window is explicitly non-qualifying:
30 samples (21 native) report queue-inclusive P50 `1037000 ms` and P95
`9507000 ms`. All 21 native cache outcomes are source-qualified cold misses;
none is unknown. Delivery is also non-qualifying: 37 completed samples report
P50 `1268000 ms`, P90 `4183000 ms`, and a `16 / 46` PR dequeue cohort.
Cancellation bounds post-dequeue work to `82000 ms` in the retained window,
but historical conflict and retry gaps remain part of the measured tail.

These measurements do not relax affected-native proof identity. Reuse remains
bound to the exact base, candidate source tree, plan projection, partitions,
tier, receipt, hosted-runner image, and observed compiler/CMake/Ninja evidence.
A reusable qualification id excludes the transient family lease, required
status snapshot, and queue-attempt binding. Those delivery facts remain
fail-closed in the descriptor and are sealed independently into the
merge-group delivery attempt and cache-promotion authority; they cannot
authorize a different source, plan, toolchain, or SDK obligation.
A successful PR run may publish proof only after its complete required native,
SDK, Shifu, and KFD dependency graph passes. The matching merge-group may
consume that proof, and a serialized repeat may consume a same-SHA queue proof,
only when lookup deterministically selects the newest trusted producer for the
exact proof identity and bundle verification preserves every identity binding.
Concurrent duplicate PR runs for the same PR head are cancelled; retained
same-identity artifacts are ordered by creation time and immutable artifact and
run ids before selection. PR proof records its triggering
head separately from the synthetic checkout; queue proof requires both SHAs to
be identical. A changed merge-group base therefore continues to fail closed to
a full run even when the PR patch and
affected plan look unchanged; the delivery report measures that cost without
authorizing base-forward reuse.

The current dev objective is queue-inclusive P50 at most 300 seconds and P95 at
most 600 seconds. These thresholds apply independently to the overall and
native strata; a fast non-native majority cannot mask a slow native tail. A
report is an observation, not a release credential, and a small passing sample
does not by itself qualify the objective. Rebuild a recent window only after it
contains at least 20 total samples and 10 native samples; otherwise the machine
verdict remains non-qualifying. Rebuild it with:

```sh
./shifu gate:latency:measure --limit 30
```

Dev admission is intentionally narrower than asynchronous observation. The
protected branch keeps the source-acceptance check and
`affected-native / linux` aggregate as its two merge-critical contexts.
Protected-Dev post-merge advisory, daily/manual patrol, and Core-profile
workflows retain Production Graph parity, Qualified Core, macOS, Windows,
full-profile, and fault evidence without placing those optional jobs in front
of required merge-group work. Advisory duration and runner-minutes are
measured separately from the required-context critical path. Alpha and release
admission remain cross-platform and fail closed according to their own matrix
rows.

The command requires `unzip` plus a read-only GitHub token through `GH_TOKEN` or
`GITHUB_TOKEN`, or an authenticated `gh` client. It reads pull requests,
workflow/check metadata, changed paths, and effective branch rules; it does not
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
gh workflow run gate-measurement.yml \
  --ref "$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')" \
  -f source-ref=<FULL_SHA>
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
