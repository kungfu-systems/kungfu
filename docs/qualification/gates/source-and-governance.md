# Source, documentation, and governance gates

These gates protect source shape, contribution and ADR policy, documentation, and the control plane itself.

Each section is bound to the registry id by the catalog meta gate.

<a id="gate-catalog"></a>
<!-- gate-doc:gate.catalog -->
## Gate catalog integrity (`gate.catalog`)

- **Problem:** Keeps the registry, matrix, gate docs, task actions, and workflow bindings consistent.
- **Protects:** governance regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu check:gate-catalog`
- **Dependencies:** none.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain gate.catalog --profile <profile>`; reproduce with `./shifu gate run gate.catalog` on a capable runner.
- **Cost:** light; timeout 600 seconds.
- **Current source:** .github/workflows/affected-native-pr.yml (source_acceptance; every dev pull request and merge-group candidate inside the staged required aggregate; an exact accepted pull-request proof may satisfy merge-group source acceptance only when source, base movement, policy, closure, dependency, runtime, required-context, and controller-receipt predicates all match, otherwise the full source gate runs); .github/workflows/dev-verify-patrol.yml (verify; daily or manual on dev); .github/workflows/build.yml (build; every alpha pull request; one four-platform Buildchain build and alpha:qualify invocation); .github/workflows/publish-layer-artifacts.yml (verify-publication; manually executed public layer publication)
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:gate.catalog -->

<a id="governance-dco"></a>
<!-- gate-doc:governance.dco -->
## DCO sign-off (`governance.dco`)

- **Problem:** Rejects pull-request commits without a valid Signed-off-by trailer.
- **Protects:** governance regressions from becoming an unexplained green profile or release claim.
- **Action:** named handler `kungfu.workflow.dco`; execution requires the declared remote controller capability.
- **Dependencies:** none.
- **Platforms and runner:** linux; capabilities `github-event`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain governance.dco --profile <profile>`; reproduce with `./shifu gate run governance.dco` on a capable runner.
- **Cost:** light; timeout 120 seconds.
- **Current source:** .github/workflows/affected-native-pr.yml (dco; every dev pull request inside the staged required aggregate); .github/workflows/dco.yml (signoff; pull requests except dev/v*/v*; dev DCO is owned by dev-candidate-dco)
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:governance.dco -->

<a id="governance-buildchain-config"></a>
<!-- gate-doc:governance.buildchain-config -->
## Buildchain lifecycle configuration (`governance.buildchain-config`)

- **Problem:** Validates version state and required lifecycle declarations.
- **Protects:** governance regressions from becoming an unexplained green profile or release claim.
- **Action:** named handler `kungfu.workflow.buildchain-config`; execution requires the declared remote controller capability.
- **Dependencies:** none.
- **Platforms and runner:** linux; capabilities `buildchain-cli`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain governance.buildchain-config --profile <profile>`; reproduce with `./shifu gate run governance.buildchain-config` on a capable runner.
- **Cost:** light; timeout 120 seconds.
- **Current source:** .github/workflows/affected-native-pr.yml (candidate_buildchain_config; every dev pull request and merge-group candidate before governance preflight or expensive queue work); .github/workflows/buildchain-validate.yml (validate; pull requests except dev/v*/v*, or alpha/release channel push); .github/workflows/release-new-version.yml (promote; merged alpha or release pull request, or manual source-locked dry-run measurement); .github/workflows/release-new-version.yml (recover; manual recovery of one verified sealed Alpha candidate without product rebuild).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:governance.buildchain-config -->

<a id="source-acceptance"></a>
<!-- gate-doc:source.acceptance -->
## Build-free source acceptance (`source.acceptance`)

- **Problem:** Runs the immutable dev source gate without compiler or release lifecycles.
- **Protects:** source regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu check:source`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain source.acceptance --profile <profile>`; reproduce with `./shifu gate run source.acceptance` on a capable runner.
- **Cost:** light; timeout 1800 seconds. This budget covers cold shared-runner
  Project Cut composition while retaining a bounded failure signal.
- **Current source:** .github/workflows/affected-native-pr.yml (source_acceptance; every dev pull request and merge-group candidate inside the staged required aggregate; an exact accepted pull-request proof may satisfy merge-group source acceptance only when source, base movement, policy, closure, dependency, runtime, required-context, and controller-receipt predicates all match, otherwise the full source gate runs). The standalone .github/workflows/source-acceptance.yml is manual-only.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:source.acceptance -->

The pull-request run seals an exact Buildchain source-qualification proof. A
merge-group run may reuse it only when the source head, merge composition,
protected-base movement, source-policy and execution-closure paths, dependency
inputs, Buildchain runtime, required context, and controller receipt all match.
The reused lifecycle remains explicit that the source command was not executed
again. Missing or stale evidence, an unknown base delta, path overlap, or any
predicate mismatch fails closed to the full `./shifu check:source` path; proof
reuse does not grant approval, Warrant, queue, merge, or publication authority.

<a id="source-changed-scope"></a>
<!-- gate-doc:source.changed-scope -->
## Affected Core native developer check (`source.changed-scope`)

- **Problem:** Resolves changed Core paths through the architecture authority and compiles, links, and tests the bounded native impact closure.
- **Protects:** template instantiation, link, public-header propagation and
  native contract regressions that the deliberately build-free source gate
  cannot observe.
- **Action:** `./shifu core:affected -- --execute`
- **Production Graph shadow:**
  `./shifu core:affected:graph-shadow -- --graph GRAPH --plan PLAN
  --verification-receipt VERIFICATION --execute` is an additive, temporary-root
  consumer of one verified `core:affected` graph node. It validates the exact
  contract/compiler verifier, source, authority, Xinfa selection, topology and
  compiled plan before delegating to this unchanged action. Its graph receipt
  and parity result are evidence only and never replace this Gate, planner,
  executor, Buildchain logging, native qualification, or current receipt.
- **Dependencies:** `gate.catalog`, `source.acceptance`.
- **Workflow execution:** the partition worker uses the explicit diagnostic
  `--omit-dependency source.acceptance` form. The staged candidate workflow has
  a distinct reusable source-acceptance job, and every expensive merge-group
  job has an explicit `needs` edge to that job and the governance preflight.
  The partition therefore does not rerun the build-free closure, while the
  final required aggregate still fails closed if source admission did not pass.
- **Platforms and runner:** linux; capabilities `native-toolchain`.
- **Pass:** the resolver validates the authority, selects a supported minimal
  profile, and the selected configure/compile/link/CTest closure passes.
- **Failure or skip:** unclassified Core files, missing target/test evidence,
  stale authority, unsupported profiles, native failures, timeout or receipt
  drift are non-qualifying. A planner error never means "no native impact".
- **Evidence:** the unified Gate receipt plus
  `kungfu.core-affected-native-receipt/v1` and raw per-step logs under
  `product/qualification/affected-native/`. The receipt binds exact source,
  architecture digests, toolchain, targets/tests, duration and honest cache
  facts. The retained `kungfu.core-affected-native-plan/v1` is created before
  dependency bootstrap; execution rejects a different source HEAD, authority
  digest, or plan digest. Native runs additionally retain Buildchain JSONL spans
  for install/configure/build/test, compact runner/tool/compiler-cache
  diagnostics, and a summarized compile process-tree sample. The receipt binds
  the diagnostics digest and `source.changed-scope` consumer contract; raw
  process snapshots and environment dumps are not retained.
- **Portable cache:** native plans produce separate Buildchain
  `buildchain.portable-dev-cache-manifest/v1` dependency and compiler layers.
  Pinned Actions cache restore/save only transports the declared roots;
  Buildchain owns exact keys, compatible restore prefixes, and receipts. The
  exact root binds source and plan while compatibility also requires the same
  hosted image, platform/architecture, toolchain, lock set, profile, and roots.
  Exact or compatible restores still run the current configure/build/CTest
  closure. Misses run and record the cold path; per-run ccache statistics are
  retained beside the provider receipts so an exact restore cannot be confused
  with effective compiler hits. The dev-only affected-native native closure and
  SDK build plan disable C++ module dependency scanning because the current
  closure declares no module sources; this avoids uncached scan and compile work
  without weakening installed SDK qualification or changing alpha/release build
  semantics. Contradictory or foreign-key evidence fails closed. Successful
  queue candidates may restore a compatible base-branch baseline while
  retaining source-bound exact keys and always rerunning configure/build/CTest.
  GitHub scopes a cache saved by a merge-group run to its synthetic queue ref,
  so that cache is not itself a reusable base-branch baseline. After a
  successful native Gate, each pull-request or merge-group partition instead
  seals its secret-free cache roots into a source-, run-, plan-, partition-,
  receipt-, and digest-bound artifact. The resulting trusted dev push locates
  the exact successful merge-group admission. A direct merge-group build
  supplies its own complete partition set. A merge group that reused an exact
  pull-request proof instead seals a separate immutable promotion authority
  that binds the merged head and source tree to the verified proof root,
  producer run, producer checkout, plan projection, and partition contract.
  The push independently revalidates that authority before selecting the exact
  producer payloads; it never rewrites their source-bound receipts as
  merge-group evidence. It then requires the complete partition set,
  revalidates every payload and receipt, combines the compiler roots, and writes
  the result into the long-lived base-branch cache scope. A non-native push or
  any missing, ambiguous, stale, source-drifted, or malformed producer or
  authority is an auditable no-op. The push transports already-qualified cache
  data and does not repeat the candidate-equivalent native build.
- **Cold-path partitioning:** the authoritative target and CTest lists are split
  deterministically across two GitHub-hosted Linux jobs. Each receipt binds its
  zero-based partition index, partition count, selected targets/tests, partition
  digest, and the common full-closure coverage digest. The stable
  `affected-native / linux` admission job succeeds only after the entire matrix
  succeeds. The retained latency collector rejects missing, duplicate,
  source-drifted, plan-drifted, or coverage-drifted partition artifacts before
  aggregating their critical-path timings. Dependency cache identity stays
  common. Compiler exact roots bind the partition through the exact plan digest,
  while their compatibility identity stays common across affected profiles
  under the same hosted image, toolchain, lock set, authority, platform tier,
  and roots. Independently produced queue-ref roots therefore cannot collide,
  while the trusted base-push promotion can publish their validated union for
  later compatible restores. This preserves configure/build/CTest coverage
  while using parallel GitHub-hosted capacity for a cold cohort.
- **Repeated-run proof admission:** workflow concurrency prevents concurrent
  executions sharing one synthetic merge-group SHA; `cancel-in-progress: false`
  preserves the active execution while GitHub may coalesce identical pending
  replacements. A successful pull-request candidate or first queue execution
  produces an authoritative proof. A merge group or later same-SHA queue
  execution skips the repeated native/SDK, Shifu workspace, and KFD work only
  after deterministic lookup selects a completed-success artifact and
  cryptographic verification binds the same base, candidate tree, plan
  projection, partition set, platform tier, hosted-runner image, and observed
  compiler/CMake/Ninja facts. Moved bases, changed trees/toolchains, expired or
  untrusted evidence, and every lookup/download/verification failure run the
  full required set.
  The reusable qualification id intentionally excludes the transient family
  lease, required-status snapshot, and queue-attempt binding. The current
  merge-group descriptor must still validate those facts, and its delivery
  attempt and cache-promotion authority seal their exact binding root
  independently before admission.
  The producer workflow must itself be completed-success, so the source-bound
  plan also proves that its SDK, Shifu, and KFD obligations passed before a
  repeated run can skip them. The probe descriptor is handed unchanged to the
  aggregate job: that job independently recomputes the base, candidate tree,
  and plan projection with the probe's sealed toolchain facts instead of
  substituting facts from a later non-native runner. Every native shard receipt
  must still match the complete probe toolchain, including the hosted image
  version; cross-runner drift therefore remains fail-closed. Shifu workspace
  and KFD remain independent on the producer execution; only a candidate backed
  by that completed-success exact proof may skip them.
- **Durable queue admission lease:** the dev ruleset additionally requires
  `Queue admission lease`. The pull-request delivery controller submits exact
  Source Qualification Proof evidence to the pinned Buildchain Warrant queue;
  only its active, unexpired provisional Warrant may own native proof work and
  waiting. GitHub enqueue and the merge-group-only workflow require that same
  fenced Warrant to be atomically upgraded to `qualified`, with exact native
  proof and reuse roots; legacy `selected`, `proving`, `waiting`, or `blocked`
  states are not merge authority. The merge-group workflow reads the same
  durable state ref and refuses revision, source-head, Warrant, proof-root,
  fencing-token, generation or expiry drift on the exact synthetic SHA. The
  affected-native aggregate then binds
  its reconstructable delivery attempt and the live GitHub queue entry into an
  exact Integration Delivery Proof and records that proof through Buildchain's
  state-ref CAS before protected merge observation. Every non-merged dequeue
  revokes the exact-head lease and forbids retrying that head; a normal `merged`
  removal preserves the successful terminal lease instead of replacing it with
  a misleading failure. A new head cannot inherit an older proof or Warrant.
  The bounded contract is
  `docs/qualification/gates/dev-queue-admission.contract.json`. This prevents an
  inadvertent or stale controller from changing the proof base; reusable source
  qualification never suppresses exact merge-group verification when source,
  plan, dependency, toolchain, Warrant or integration identity changes.
- **Dequeue repair admission:** the dequeue controller executes from the
  event-selected current protected `dev/v*/v*` base ref, never from the
  pull-request head or a stale event base SHA. It cancels active work and writes
  one PR marker for deterministic `failed_checks`, `merge_conflict`, or
  `invalid_merge_commit` exits. The marker binds the exact pull-request head
  SHA. Atlas merge orchestration rejects a later enqueue of
  that same head, including from another account or thread, and observes a new
  source SHA as the only ordinary unlock. Manual dequeues remain unmarked so
  position-one serialization can yield without manufacturing a repair debt.
- **Rebase-queue admission:** pull-request candidate preflight uses
  `./shifu project-cut:queue-admission -- --base <base> --head <head>` to replay
  the exact first-parent series onto the protected base with unreachable Git
  objects only. A deterministic conflict fails before native, SDK, Shifu, or
  KFD work starts. Merge-group events skip this PR-only check because the queue
  has already synthesized their candidate source.
- **Diagnosis:** inspect without building with `./shifu core:affected -- --base
  <base> --head <head> --json`; run mutation fixtures with `./shifu
  core:affected -- --self-test`.
- **Cost:** heavy; timeout 1500 seconds.
- **Current source:** .github/workflows/affected-native-pr.yml (affected_native_shards; two deterministic GitHub-hosted Linux partitions on the first exact merge-group execution after governance planning and proof probing, or after any reuse mismatch; the stable affected-native aggregator reports fast PR admission and admits either the complete impact-selected queue set or one verified exact same-SHA queue proof)
- **Parallel source orchestration:** the workflow runs authoritative Buildchain
  source acceptance concurrently with the impact-selected native/SDK, Shifu,
  and KFD lanes. Those execution lanes start only after the build-free
  governance planner and proof probe pass; every optional skip is justified by
  a `required: false` decision retained in the plan. A source failure invokes
  an `actions: write`-scoped controller that cancels the current workflow and
  its in-flight selected lanes; it cannot cancel another run. The stable
  aggregate still waits for and requires successful source acceptance together
  with every selected lane, so concurrency shortens the healthy critical path
  without admitting a source failure or letting an already-doomed SDK shard
  run to completion. A non-empty, source-bound native plan enters the
  registered action; a tier-none plan writes the same receipt directly without
  installing Buildchain, Conan, or the workspace.
- **SDK workflow impact:** the build-free planner compares a bounded semantic
  projection of the candidate planner and affected-native shard through the
  installed four-language SDK qualification step. The shard's
  `source_acceptance` dependency and unrelated jobs are scheduling-only, so
  changing only those fields does not rebuild the SDK. Changes to any other
  dependency, runner, permissions, environment, matrix, timeout, planner
  wiring, SDK preparation/build/pack/qualification step, or an unreadable or
  incomplete workflow projection require SDK qualification.
- **Retirement:** remove only with a replacement that consumes the same
  architecture authority and preserves changed-path completeness, raw native
  evidence and the alpha/release responsibility split.
<!-- /gate-doc:source.changed-scope -->

<a id="source-whole-tree"></a>
<!-- gate-doc:source.whole-tree -->
## Whole-tree developer check (`source.whole-tree`)

- **Problem:** Runs repository-wide lint, format, Rust, contract, docs, SDK, and tooling checks.
- **Protects:** source regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu check:all`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `node`, `rust`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain source.whole-tree --profile <profile>`; reproduce with `./shifu gate run source.whole-tree` on a capable runner.
- **Cost:** heavy; timeout 2400 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:source.whole-tree -->

<a id="docs-contracts"></a>
<!-- gate-doc:docs.contracts -->
## Documentation structure and contracts (`docs.contracts`)

- **Problem:** Checks Markdown, links, metadata, ADR projections, examples, and toolchain pins.
- **Protects:** documentation regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu docs:check:readonly`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain docs.contracts --profile <profile>`; reproduce with `./shifu gate run docs.contracts` on a capable runner.
- **Cost:** light; timeout 600 seconds.
- **Current source:** .github/workflows/dev-verify-patrol.yml (verify; daily or manual on dev); .github/workflows/docs-external-links.yml (external-links; daily or manual)
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:docs.contracts -->

<a id="docs-prose"></a>
<!-- gate-doc:docs.prose -->
## Required documentation prose policy (`docs.prose`)

- **Problem:** Applies qualified objective prose rules that block pull requests.
- **Protects:** documentation regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu docs:prose:required`
- **Dependencies:** `docs.contracts`.
- **Platforms and runner:** linux; capabilities `docker`, `node`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain docs.prose --profile <profile>`; reproduce with `./shifu gate run docs.prose` on a capable runner.
- **Cost:** light; timeout 600 seconds.
- **Current source:** independent Shifu task; not selected by a current remote profile.
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:docs.prose -->

<a id="docs-external-links"></a>
<!-- gate-doc:docs.external-links -->
## External documentation links (`docs.external-links`)

- **Problem:** Checks remote URLs separately from deterministic source acceptance.
- **Protects:** documentation regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu docs:check:external`
- **Dependencies:** `docs.contracts`.
- **Platforms and runner:** linux; capabilities `network`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain docs.external-links --profile <profile>`; reproduce with `./shifu gate run docs.external-links` on a capable runner.
- **Cost:** light; timeout 900 seconds.
- **Current source:** .github/workflows/dev-verify-patrol.yml (verify; daily or manual on dev); .github/workflows/docs-external-links.yml (external-links; daily or manual).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:docs.external-links -->

<a id="shifu-workspace"></a>
<!-- gate-doc:shifu.workspace -->
## Shifu workspace matrix (`shifu.workspace`)

- **Problem:** Formats, lints, tests, release-builds, and smokes Shifu on three hosted OSes.
- **Protects:** toolchain regressions from becoming an unexplained green profile or release claim.
- **Action:** `./shifu check:shifu-workspace`
- **Dependencies:** `gate.catalog`.
- **Platforms and runner:** linux, macos, windows; capabilities `rust`.
- **Pass:** the structured action exits successfully, required artifacts exist, and the Gate receipt remains current for the source and definition.
- **Failure or skip:** action failure, timeout, unsupported required capability, dependency failure, or missing required artifact is non-qualifying; advisory mode remains visible.
- **Evidence:** unified Gate receipt; no separate artifact is currently required.
- **Diagnosis:** `./shifu gate explain shifu.workspace --profile <profile>`; reproduce with `./shifu gate run shifu.workspace` on a capable runner.
- **Cost:** heavy; timeout 1800 seconds.
- **Current source:** .github/workflows/shifu-ci.yml (check; alpha or release pull request touching the declared Shifu workspace paths); .github/workflows/affected-native-pr.yml (shifu_workspace; GitHub-hosted Linux after merge-group preflight when the exact source-impact plan requires Shifu qualification).
- **Retirement:** remove only after every selecting profile and workflow binding is migrated or explicitly replaced, with the registry and matrix changed in the same review.
<!-- /gate-doc:shifu.workspace -->
