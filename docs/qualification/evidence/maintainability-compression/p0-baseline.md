# Maintainability Compression P0 Baseline

This record freezes the evidence and smallest implementation contract for the
first phase of the maintainability-compression program. It is an auditable
cache of repository and command observations, not a new semantic authority.

## Cuts and claim boundary

- Mainline implementation baseline:
  `1ea0b2102d36b22424e0ad2ee644ccade30f3b82`
  (`origin/dev/v4/v4.0` when the canonical task worktree was created).
- Pre-queue delivery observation cut:
  `29b00b9b23f5035c7c1ae8672894b3df275ff617`
  (`origin/dev/v4/v4.0` after the initial pre-PR synchronization).
- Intermediate queue cut:
  `59ad881852bf3debb181b9e91953ce8700b071d5`
  (`origin/dev/v4/v4.0` after PRs #1553 and #1554 advanced the queue).
- Intermediate queue cut:
  `72d8a5fcfa5ed61f280f12dddc43253e341a83b0`
  (`origin/dev/v4/v4.0` after PR #1557 advanced the queue).
- Intermediate queue cut:
  `92cbae5c1b53d0859861a7a84ee518e933c83603`
  (`origin/dev/v4/v4.0` after PR #1560 advanced the queue).
- Intermediate queue cut:
  `2cb76229de584fd9a4b8e92ba316eb98e572808f`
  (`origin/dev/v4/v4.0` after PR #1562 advanced the queue).
- Intermediate queue cut:
  `0d894b38af1f869e57c03b9a4ffdd2f8db02e7e2`
  (`origin/dev/v4/v4.0` after PR #1563 advanced the queue).
- Intermediate queue cut:
  `4003c4485b508181c3e2157ed8435b551a8dbf80`
  (`origin/dev/v4/v4.0` after PR #1564 advanced the queue).
- Final delivery ratchet baseline:
  `dbfed9ca1785d147b26f4f06e7e6895ac7368fee`
  (`origin/dev/v4/v4.0` after PR #1559 advanced the KFD support-claim
  authority and its generated evidence). The
  calibrated complexity baseline and semantic changed-surface comparison use
  this final target cut so already-admitted upstream work is not misclassified
  as this branch's regression. All earlier observation cuts remain immutable.
- Protected local-main reproduction cut:
  `be1171bc0a11c7226b61b47a8cd66c828927bf43`.
- Task branch: `feature/maintainability-compression`.
- Architecture authority root reported by the retained health projection:
  `sha256:ac2b6636a8e409f50c68d51d5cc814cb9ed1fb21522cd7b4ba157fbcf1d4a1e7`.
- Documentation inventory root:
  `sha256:f8fa8a7e73ec164d06fc0d06bafaefab12ef2626c60cd951b1fcb0a2d746dc34`.
- The local protected main was behind the implementation baseline. The failure
  reproduction proves the physical write-path defect at its exact cut; it does
  not imply that every mainline commit has identical bytes.

This P0 record proves source observations only. It does not claim an installed
product, packaged cross-platform parity, production durability, release
admission, or completion of the parent Assignment.

## Protected-main reproduction

The protected checkout remained locked. No `chflags`, permission change,
dependency installation, cleanup, or repair command was used.

| Command | Exit | Result | Git before/after |
| --- | ---: | --- | --- |
| `./shifu --version` | 0 | source launcher identity returned | clean / clean |
| `./shifu --help` | 0 | launcher help returned | clean / clean |
| `./shifu docs inventory --json` | 0 | complete inventory returned | clean / clean |
| `./shifu core:architecture --path framework/core/src/libkungfu/src/runtime/storage/service.cpp --json` | 1 | dependency and diagnostics writes hit `EPERM` | clean / clean |
| `./shifu core:architecture:health --json` | 1 | same write path hit `EPERM` | clean / clean |
| `./shifu invariant:verify -- --list --json` | 1 | same write path hit `EPERM` | clean / clean |

The failing commands first entered `pnpm install`, which attempted to open a
root `_tmp_*` file. Shifu then attempted to create
`.buildchain/diagnostics`. Both writes were rejected by the protected checkout.
The failure is therefore in command bootstrap and diagnostics routing, not in
the read-only Core query implementation: `query-health.mjs` reads checked-in
JSON and writes projections only under explicit `--write-projections`.

## Existing authority and projection graph

The following graph is a bounded navigation view over existing authorities. A
later machine report must resolve every referenced projection and fail on
unknown ownership; this table does not become a replacement registry.

| Semantic family | Existing authority | Projections and bindings | Compatibility, tests, docs, and release surfaces |
| --- | --- | --- | --- |
| Core ownership and build closure | `framework/core/architecture/layers.json` plus `build-capabilities.json` | `TARGETS.cmake`, `review-routes.json`, `ARCHITECTURE_INDEX.md`, `ARCHITECTURE_HEALTH.md`, `query-health.mjs` | `check-layers.mjs`, architecture query fixtures, affected-native selection, source acceptance |
| CLI and Agent capability surface | Click command registration and Profile/KFX contributions, with stable identities linked through the KFD-3 API registry | human help, `commands.json`, `index.json`, installed CLI, GUI/TUI/Agent projections | CLI-surface checks, command catalog generation, documentation inventory, packaged capability inventory |
| Profile, Work, and Assignment lifecycle | Core Profile/action and native Assignment fact contracts | Python CLI/API, Work Control Profile, Work Dashboard, Agent envelopes | Profile/action tests, Assignment orchestration tests, Project Cut settlement and completion review |
| KFX package and activation | Core native KFX registry, lifecycle, trust, and Product assembly policy | Node/Python thin bindings, GUI/TUI/CLI/Agent discovery and contribution landing | native KFX contract tests, KFD/Buildchain attestation, Profile Suite qualification, retained compatibility readers |
| Fact and Episode | yijinjing schema and journal authority plus declared Fact/Episode contracts | C++ services, Python/Node/C bindings, Profile facts, query and proof projections | content/hash, ledger, replay, admission, portability, invariant, and release-passport checks |
| Storage and query | Core storage ports and C++ runtime services under the architecture component map | JSON edge, Python/Node APIs, CLI storage/query commands, GUI diagnostics | durability, provider, fact-authority, query, repair, backup, migration, and known-limit evidence |
| Release and product claims | project Gate catalog plus Buildchain release evidence and Product assembly policy | source gates, native/product/package qualification, passports, promotion evidence | platform workflows, release admission, known limits, public documentation and installed evidence |

The retained Core graph currently reports 12 components across seven layers,
zero cycles, maximum fanout 11/11, maximum public-header propagation 12/12,
maximum responsibility utilization 93/100, and external dependency closure
8/12. Churn remains advisory.

## Responsibility and size pressure

The measurement excludes no files in this raw snapshot; the first two rows
show why the calibrated gate must classify vendored/generated material before
blocking. The implementation baseline contains approximately 502,187 lines
across tracked C/C++, Python, TypeScript/JavaScript, Rust, and shell files in
the raw extension scan.

Representative large first-party implementation surfaces:

| Path | Lines | 2026 changes | Current responsibility signal |
| --- | ---: | ---: | --- |
| `extensions/work-control/work-control-actions/domain/mission_control.py` | 4,223 | 26 | domain declarations, actions, queries, bundles, and authority migration share one module |
| `developer/sdk/src/sdk.js` | 3,793 | 30 | broad SDK projection and compatibility surface |
| `framework/core/src/python/kungfu/profile_sdk.py` | 3,138 | 18 | Profile authoring, composition, actions, and qualification |
| `framework/core/src/libkungfu/src/runtime/storage/service.cpp` | 2,789 | 60 | public storage facade and shared application-service composition |
| `framework/core/src/libkungfu/src/runtime/query/fact_query.cpp` | 2,596 | not in top churn set | parsing, query execution, proof, and rendering pressure |
| `product/scripts/dist.mjs` | 2,514 | 46 | multi-platform Product assembly and release packaging |
| `framework/gui/src/renderer/src/main.tsx` | 2,004 | 51 | renderer composition and product surface concentration |
| `framework/project-cut/src/settlement.mjs` | 1,977 | not in top churn set | settlement, evidence, Git, and continuation policy |
| `framework/core/src/python/kungfu/runtime_service.py` | 2,286 | 17 | runtime orchestration and product-service projection |
| `framework/core/src/python/kungfu/storage/service.py` | 1,737 | 45 | Python storage edge and operation routing |
| `framework/core/src/python/kungfu/workspace.py` | 1,601 | not in top churn set | workspace plan, mutation, and recovery composition |
| `framework/gui/src/main/index.ts` | 1,269 | 56 | Electron main-process composition |

The existing Core authority already carries ten hand-maintained
`source_constraints` with responsibility text, line maxima, required symbols,
and forbidden responsibility leakage. The new repository-wide budget must
generalize that ratchet without silently replacing or weakening it.

## P0 contract

### Read-only floor

1. Dispatch declared read-only source queries before native launcher bootstrap,
   `fnm install`, `pnpm`, cache repair, and repository diagnostics.
2. Execute only checked-in, build-free readers over checked-in authorities.
3. Never fall through from a read-only route to an install or build path.
4. Return one stable JSON diagnosis when the required local executable is
   absent or stale; do not repair it implicitly.
5. Keep projection writers behind explicit write commands. Query aliases must
   not pass `--write-projections`.
6. Qualify both a locked real checkout and a synthetic read-only filesystem
   fixture with Git and filesystem before/after evidence.

The smallest first slice covers Core architecture query/health and invariant
listing because they currently reproduce the defect. Documentation inventory,
launcher help, and version are retained as already-passing controls. Additional
ownership, affected-test, recovery, and task-graph routes may be admitted only
when they read existing authorities and do not add a parallel registry.

### Complexity and amplification measurement

1. Classify every eligible tracked file before applying a budget.
2. Keep separate classes for first-party handwritten implementation, public
   headers or entrypoints, tests or fixtures, declarative schemas or tables,
   generated projections, vendored source, and retained evidence.
3. Calibrate language-and-role soft/hard budgets from the frozen distribution;
   no universal number is introduced in P0.
4. Freeze grandfathered over-budget measurements. P0 blocks unknown
   classification, unknown ownership, non-read-only behavior, and invalid
   reports only.
5. Treat length as one signal. Responsibility count, dependency direction,
   fanout, churn, semantic change amplification, affected-change closure,
   ownership, and qualification remain independent blocking inputs.
6. A waiver never changes the baseline. It must bind the exact delta, owner,
   rationale, rejected splits, tests, independent approver, expiry/review cut,
   and retirement reference.

## Bounded child dependency graph

```text
P0 evidence freeze
  ├─ readonly-agent-bootstrap
  └─ maintainability-measurement-and-budget
       ├─ 2026-07-26-kungfu-authority-convergence
       └─ 2026-07-26-kungfu-responsibility-hotspot-decomposition
readonly-agent-bootstrap + semantic-authority-convergence
  └─ agent-task-graph
all implementation children
  ├─ 2026-07-26-kungfu-linux-product-qualification
  └─ 2026-07-26-kungfu-windows-product-qualification
       └─ parent independent review and settlement
```

The four residual children are captured, but not admitted, claimed, or
executed:

| Assignment | Request root | Capture receipt root |
| --- | --- | --- |
| `2026-07-26-kungfu-authority-convergence` | `sha256:3c21a18843d601a08012bce640fa6c184358179cc9f82999d7420b80d7806b97` | `sha256:e9668f6ac8cf97bb59db87c1c5ec04076dd14b4d294abc1a25408c2d2dfb552b` |
| `2026-07-26-kungfu-responsibility-hotspot-decomposition` | `sha256:5f71d58aac57e46f268dd1953473249aab182e0e3f8061a7d75929c3f81be9ee` | `sha256:9694edded6e090e588c56286ebf9c957718ecfb14b3e92b8b74e7ffbcace2bde` |
| `2026-07-26-kungfu-linux-product-qualification` | `sha256:abfb20e87a7c06437431c133b4e32c5cb72a8c1ca4c7e5ddb8917b7eb77e0a4f` | `sha256:91305cbc2255ed4ef18e2f7966be6f9acbc7ea68544b1535c261a70cebfa8974` |
| `2026-07-26-kungfu-windows-product-qualification` | `sha256:2abb9fb07ac8c09ca1658388731b23a1fd47bbe8115ec284cc24c54e93b2157c` | `sha256:bc649a491246506f2e0067b089af5539136ebce8972270c2783650ca8f7b1b04` |

Each child must preserve exact authority, compatibility, and rollback
invariants. Authority cutovers and hotspot migrations remain serialized.
Independent measurement or fixture work may run in parallel after the P0
contract is accepted. The parent remains open until every acceptance item is
proved or transferred to an explicit retained dependency with a non-inflated
claim boundary.

## P0 falsification

P0 is false if any declared read-only command writes to the checkout, installs
or repairs dependencies, needs network access, emits unstable machine output,
or succeeds only because an existing mutable cache hides the cold path. It is
also false if unknown files or owners are ignored, generated/vendored files are
counted as handwritten implementation, a line reduction increases
responsibility concentration, or a waiver can be self-approved or reused.
