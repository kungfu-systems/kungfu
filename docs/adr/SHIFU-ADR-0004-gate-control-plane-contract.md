---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: SHIFU-ADR-0004
decision_status: accepted
implementation_status: implemented
implementation_prs: [https://github.com/kungfu-systems/kungfu/pull/762, https://github.com/kungfu-systems/kungfu/pull/765, https://github.com/kungfu-systems/kungfu/pull/767, https://github.com/kungfu-systems/kungfu/pull/769, https://github.com/kungfu-systems/kungfu/pull/773, https://github.com/kungfu-systems/kungfu/pull/781, https://github.com/kungfu-systems/kungfu/pull/786, https://github.com/kungfu-systems/kungfu/pull/1004, https://github.com/kungfu-systems/kungfu/pull/1014, https://github.com/kungfu-systems/kungfu/pull/1020, https://github.com/kungfu-systems/kungfu/pull/1095, https://github.com/kungfu-systems/kungfu/pull/1128, https://github.com/kungfu-systems/kungfu/pull/1240, https://github.com/kungfu-systems/kungfu/pull/1250]
closure_pr: https://github.com/kungfu-systems/kungfu/pull/781
qualification_refs: [scripts/shifu-gate-runtime.test.mjs, scripts/check-kungfu-gate-catalog.test.mjs, scripts/shifu-cache-runtime.test.mjs, scripts/measure-dev-required-latency.test.mjs, scripts/run-core-affected-native.mjs, scripts/affected-native-proof.test.mjs, scripts/write-affected-native-cache-manifests.test.mjs, .github/workflows/affected-native-pr.yml, .github/workflows/core-build-profiles.yml, .github/workflows/dev-verify-patrol.yml]
review_state: self-reviewed
sensitivity: public
sources: [local-files, user-consensus]
period: ongoing
theme: shifu-gate-control-plane
confidence: high
evidence_grade: B
last_reviewed: 2026-07-22
---

# SHIFU-ADR-0004: Gate control plane contract

- Status: accepted and implemented
- Date: 2026-07-13
- Scope: Shifu quality and release gate declaration, explanation, planning,
  execution, and receipts
- Related: [SHIFU-ADR-0001](./SHIFU-ADR-0001-cache-profile-contract-and-ownership.md),
  [ADR-0044](./ADR-0044-shifu-delegation-protocol.md), and
  [ADR-0073](./ADR-0073-buildchain-adr-release-admissibility.md)

## Context

Kungfu gates currently exist across package tasks, aggregate scripts, and
workflow jobs. Some are light source checks; others build native products,
exercise cross-language membranes, qualify Episodes, fuzz targets, or release
artifacts. The distinction affects scheduling cost, but each gate still needs
the same answers: what problem it detects, what it runs, what it depends on,
where it can run, which release profiles require it, and what evidence it
produces.

Encoding those answers separately in package scripts, workflow YAML, prose,
and branch protection creates multiple policy authorities. Hard-coding the
Kungfu catalog into Shifu would avoid one local duplication while coupling a
general execution tool to one project forever.

## Decision

Shifu owns one versioned Gate contract and the commands that validate,
explain, compare, and plan it. Consuming projects own registry instances:
concrete ids, structured actions, dependencies, platforms, runner
capabilities, cost, documentation, artifacts, receipt expectations, and every
explicit profile decision.

Light and heavy gates share one schema. Cost is scheduling metadata, not a
separate command family. Profiles use `required`, `advisory`, and `off`; every
profile must decide every gate, and dependencies cannot be weaker than the
gates that require them.

Actions are structured Shifu tasks, argv vectors, or named handlers. Raw shell
strings are not the contract because they hide quoting, platform, and authority
semantics.

The inspection control surface is `shifu gate validate|list|show|explain|matrix|plan`.
Validation is independent of registry validity. Planning closes dependencies,
emits deterministic groups and platform constraints, and never turns a local
diagnostic selection override into qualifying policy evidence.

The execution control surface is `shifu gate run` plus
`shifu gate receipt validate`. Explicit gate runs are diagnostic. A profile run
executes its dependency closure once and emits a receipt bound to the source
SHA, dirty state, registry and plan digests, per-gate definition and action
digests, platform, capabilities, required action coverage, artifact presence,
and redacted evidence pointers. Child output and inherited environment values
are not receipt fields.

When a cache profile is projected, `gate run` enters Shifu cache application
once at this outer execution boundary. Task actions inherit the active cache
context, disposable tool configuration, and Conan storage lock; they do not
resolve or apply the profile again. Read-only Gate inspection remains outside
that boundary, and build-free source acceptance uses a distinct cache-bypass
context rather than pretending cache was applied.

Qualification is recomputed, not trusted: it requires a clean Git revision, a
current profile plan and gate definitions, and complete passing coverage for
every required action. Advisory failures remain visible without blocking
required qualification. Buildchain can schedule plan groups and aggregate these
receipts, but it cannot mint missing local evidence or reinterpret policy.

Buildchain may consume a later execution plan and receipts to allocate runners
and publish stable aggregate checks. It does not own or reinterpret Shifu Gate
fields. Project maintainers retain authority over concrete release policy,
required checks, and promotion.

## Compatibility

The registry and plan identities carry their major version. Unknown v1 fields
are rejected. Additive optional fields may extend v1; removals, new required
fields, changed meanings, or changed selection semantics require v2.

Existing `./shifu <task>` dispatch remains valid. During migration, old task
entrypoints may become compatibility aliases, but they cannot remain an
independent policy source. Existing required gates are not weakened while both
paths coexist.

## Current Kungfu projection

Kungfu's first project-owned registry contains 34 light and heavy gates and
five explicit profiles: `dev-pr`, `dev-patrol`, `alpha-pr`, `release-pr`, and
`release-promotion`. The generated matrix and per-gate documentation live in
the [Kungfu Gate catalog](../qualification/gates/README.md). A dedicated meta
gate validates the registry, task references, detailed documentation, exact
generated matrix, profile coverage, and current workflow bindings together.

Task-backed workflows now enter through `shifu gate run` for ADR delivery,
promotion rehearsal, documentation closure, development full verification,
the native membrane matrix, and the Shifu workspace matrix. Supply-chain-pinned
actions and Buildchain-owned orchestration remain explicit controller bindings;
named handlers remain non-executable until those controllers register them.
The workflow bindings make that remaining compatibility debt explicit and fail
closed when either the execution authority or recorded current source drifts.

Buildchain now provides a project-neutral reusable profile workflow. It asks
the consumer's Shifu registry for a platform plan, derives a capability-aware
runner matrix, validates every platform receipt, and publishes one stable
aggregate bound to the source, registry, plan, matrix, actions, and Gate
definitions. Planning and execution accept separate argv maps so a read-only
plan does not depend on a project cache or container wrapper. Kungfu supplies
only its profile id, runner preset, non-sensitive runtime environment, and
opaque cache reference; Buildchain contains no Kungfu Gate ids or policy rows.
PR 773 published the three-platform standing dev patrol after the consumer
canary recorded its Linux/macOS failures and Windows Actions transport failure
without rewriting them as passing. Buildchain then published the controller as
stable `v2.12.2`; PR 781 pins the patrol to that release's immutable commit and
closes the project-side rollout. Gates without a current qualification binding
remain explicit `off` policy decisions rather than implicit omissions.

PR 1004 adds a stage-ready latency projection without changing Gate selection
semantics. The protected dev critical path remains the three Linux-hosted
contexts declared by branch protection. A build-free affected-native planner
now runs before dependency bootstrap, binds its plan to the exact checked-out
source and current architecture authority, and lets a proven tier-none change
finish without installing Buildchain, Conan, or the workspace. Native plans
continue through the same required Gate closure and use Buildchain `2.14.1` to
derive separate portable dependency and compiler cache keys and receipts;
restores never replace configure, build, or test execution, and misses retain a
cold fallback. A read-only measurement surface records queue-inclusive
required-context P50/P95 and refuses a qualifying verdict below the declared
sample floor. The retained initial window exceeds the target, so this projection
does not claim the latency SLO is complete; subsequent real PR samples and fault
campaign evidence must close that qualification separately.

The dev latency policy also separates merge admission from asynchronous
observation. The protected branch continues to require its three Linux-hosted
contexts, while `Core build profiles` exercises both Core profiles across
Linux, macOS, and Windows on a daily or manual trigger instead of launching six
optional jobs for every development PR. This preserves cross-platform drift
and fault visibility without allowing non-required work to queue ahead of the
required merge group. The `dev-patrol`, alpha, and release profiles retain
their existing cross-platform semantics; this scheduling change cannot mint a
qualifying receipt or weaken a matrix decision.

PR 1014 closes the cache-evidence observation boundary for that later
qualification. The latency collector reads only the final successful
affected-native run's retained artifact, validates its Buildchain dependency
and compiler receipts against the artifact source, and reports exact or
compatible warm reuse separately from qualified cold fallback. Missing,
expired, malformed, source-mismatched, or fallback-incomplete artifacts remain
unknown; elapsed time is never used to infer a hit. A latency window therefore
cannot qualify until every native sample carries authoritative cache evidence,
in addition to satisfying the sample floor and queue-inclusive P50/P95 target.

PR 1095 adds phase attribution without changing the Gate matrix or test scope.
Affected-native runs now retain source- and plan-bound Buildchain spans for
install, configure, build, and test, plus compact process-concurrency and cache
diagnostics. The collector validates the diagnostics digest and Gate binding,
reports phase P50/P95 and warm/cold cohorts, and treats older or drifted
artifacts as unknown attribution. Required-context timing ends at the first
successful pre-merge admission, retaining failed retries while excluding later
post-merge reruns. The resulting observation still does not qualify the SLO.

PR 1128 partitions the affected-native plan into two deterministic,
source-bound GitHub-hosted Linux workers behind the existing stable aggregate.
Each worker retains a disjoint target and test partition, while the aggregator
rejects incomplete, overlapping, source-drifted, or coverage-drifted evidence.
An explicit diagnostic Gate run may omit a declared dependency only when the
project's closed-world workflow authority proves that dependency remains
required and has a distinct workflow binding for the same profile; qualifying
profile runs cannot omit dependencies. Kungfu uses that rule to avoid repeating
`source.acceptance` inside each native shard while preserving the independent
required Source Acceptance workflow. The first compiler-cold cohort completed
the queue-inclusive aggregate in 480 seconds with both cold fallbacks qualified.

The earlier same-tree PR-proof reuse mechanism is now retired. Expensive native
evidence is no longer produced on pull requests, so a merge group always runs
the exact impact-selected candidate qualification after its fast preflight.
This makes the synthetic merge-group source the single authority instead of
asking PR evidence to survive a later queue ordering decision.

The affected-native source plan also declares whether partition zero must run
the installed four-language SDK wire qualification. Public ABI, schemas,
bindings, generated SDK inputs, packaging/build authority, lockfiles, the SDK
qualification harness, and any unknown root-package impact remain fail-closed
and require it. A root `package.json` change may skip only when an exact
base/head JSON projection proves that SDK/build commands and dependency policy
are unchanged; unrelated task additions do not spend the SDK qualification
budget. Internal implementation changes retain their affected native closure
without automatically rebuilding and repackaging all four SDK languages. The
decision and reasons are part of the source-bound plan digest and therefore of
the immutable proof identity.

PR 1250 extends the read-only development latency measurement surface from
required-context completion to complete merge-queue delivery. It pairs queue
entry and authoritative removal events, binds merge-group runs back to their
PR queue branch, and reports delivery percentiles, dequeue reasons, repeated
Core validation, and runner time spent by non-merged queue rounds. Missing or
nonterminal event, run, or job facts remain incomplete rather than becoming
zero. This observation does not broaden proof reuse: an affected-native proof
remains reusable only for one unambiguous candidate with the exact same base
revision, candidate merge tree, plan projection, partition contract, and
toolchain receipts. A new base therefore fails closed to `reuse: false` and a
complete run even when the PR patch and affected plan appear unchanged.

The dev candidate workflow now separates fast admission from authoritative
candidate execution. Pull requests run only build-free source acceptance,
governance preflight, and the exact source-impact plan. On `merge_group`, those
source and governance jobs are hard dependencies of the affected-native
partitions, the impact-selected three-platform Shifu matrix, and the
impact-selected KFD verifier. Those independent jobs run in parallel, and one
stable `affected-native / linux` aggregate validates every required or
explicitly-not-required result. Candidate-equivalent dev push rebuilds are
removed: a cold queue run is preferable to duplicated pre-queue and post-merge
qualification.

After PR 1254 proved the aggregate on both `pull_request` and a real
`merge_group`, dev branch protection retained only `affected-native / linux` as
the required context. The standalone Source Acceptance, ADR Release Gate, and
Docs Check workflows are manual diagnostics; DCO and Buildchain Validate ignore
dev while retaining their non-dev and alpha/release responsibilities.

The queue delivery collector also discovers non-merged PRs updated during the
selected delivery window before filtering them by authoritative queue events.
This retains closed enqueue/dequeue attempts that never produced a
`merge_group` run, while ordinary recent PRs that never entered the queue remain
outside the cohort. Completely paired rounds with no assigned Actions run
contribute zero observed runner work; missing event or job evidence stays
incomplete. This discovery correction does not change the affected-native
planner, staged candidate workflow, proof format, or exact
base/candidate/toolchain identity boundary. The current staged workflow remains
the authoritative merge-group producer and does not reuse pull-request native
proofs.

## Consequences

- Developers and agents get one human-readable and machine-readable surface
  for understanding gate policy.
- A project can select different dev, alpha, and release policies as an
  explicit matrix without teaching Shifu those project-specific names.
- New gates fail profile validation until every policy explicitly decides
  them.
- Buildchain scheduling and receipt aggregation preserve project Gate meaning
  and expose a stable aggregate for branch protection and release passports.
- The contract adds a small validation and documentation burden, paid once to
  remove repeated workflow and prose reconstruction.

## Alternatives considered

- **Keep package scripts and workflows as the catalog** — rejected because
  neither can explain the complete policy and their overlap drifts.
- **Put the Kungfu gate matrix inside Shifu** — rejected because project policy
  would become engine code and prevent reuse.
- **Model heavy gates separately** — rejected because weight changes scheduling,
  not identity, dependencies, documentation, or evidence semantics.
- **Allow missing profile entries to mean off** — rejected because a new gate
  could silently bypass every release profile.
- **Implement execution before the contract** — rejected because a scheduler
  would freeze accidental current script structure as architecture.
