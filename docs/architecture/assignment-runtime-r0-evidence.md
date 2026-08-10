# Assignment Runtime R0 source and contract evidence

## Evidence cut and claim boundary

- Audited source commit: `9277c15752b810f71e1666fbd1ba777a4b94678d`
- Contract: `framework/assignment-runtime/assignment-runtime.contract.json`
- Envelope schema:
  `framework/assignment-runtime/schema/assignment-runtime-envelope-v1.schema.json`
- Runnable cases:
  `framework/assignment-runtime/fixtures/contract-cases-v1.json`
- Decision: `KF-ADR-019fdb93-19ac-7362-8ab0-f8ed19c7bef8`

R0 proves a coherent, runnable protocol contract and an exact source inventory.
It does not prove that a Local Runtime server/client exists or that current
clients already consume this protocol.

## Current source-to-contract inventory

| Surface | Exact current authority or path | R0 finding | Contract mapping | Phase disposition |
| --- | --- | --- | --- | --- |
| Build-free Assignment capture | `framework/assignment-capture/assignment-capture.mjs`, `assignment-request.schema.json` | Writes immutable pre-admission request and receipt bytes under the selected data-home inbox; intentionally creates no runtime or Assignment authority | `command.submit` may later wrap capture, but capture remains a distinct pre-admission compatibility ingress | retain; R1 adapter must preserve content roots |
| Workspace and Home selection | `framework/core/src/python/kungfu/workspace.py`; `cli/commands/assignment.py::_runtime` | CLI resolves logical Home/project identity, prepares writes, and receives a physical runtime directory | `realm.realmId`, `realmKind`, and `generation`; no physical path in public envelopes | R1 moves path resolution behind Local Runtime |
| Native state writer | `extensions/work-control/work-control-actions/domain/work_control_runtime.py` | Work Control Profile appends Initiative, Assignment, execution-claim, phase, completion, review, and continuation facts | one `realm-runtime` writer; `command.submit`, CAS, idempotency, receipts | preserve as R1 domain adapter, not client API |
| Native state fold | `work_control_runtime.py::assignment_orchestration_status`; `domain/native_state.py` | Fact-backed query and completion-cycle fold own canonical phase and proof roots | snapshot/get/query revision and canonical root parity | R1 exposes this fold; clients do not reproduce it |
| CLI orchestration | `framework/core/src/python/kungfu/cli/commands/assignment.py` | CLI loads/qualifies Profile source, invokes member adapters, binds Agent work, coordinates Dogfood, and returns status | Runtime Client request/response plus diagnostics and recovery | migrate in R3; retain CLI compatibility names |
| CLI `next_actions` and gate projection | `framework/core/src/python/kungfu/assignment_orchestration.py::next_actions` and `gate` | Client-side orchestration derives next actions from the Profile-owned phase and emits an Atlas compatibility projection | Runtime snapshot carries canonical next actions and gate receipts | centralize in R1; remove duplicate fold only after parity |
| Execution identity and lease | `work_control_runtime.py::claim_assignment_execution`; `assignment_lifecycle/ports.py` | Owner, Agent, Slot, lease, attempt binding, and expiry are explicit, but Python ports expose runtime directories | typed attempt, claim, lease, Warrant, generation, and stable errors | R1 replaces path-bearing application port |
| Portable closeout | `assignment_orchestration.py::sealed_state_plan`, `apply_sealed_state`, `verify_sealed_state` | Exact expected-root fence writes a path-free settlement witness in Git common storage | receipt references and recovery; never a second live authority | retain compatibility and expose receipts |
| GUI projection and mutation | `extensions/work-dashboard/src/view/work-control-profile.ts`; `view/index.tsx` | Work Dashboard calls Profile members directly for reads and authorized mutations | GUI becomes a Runtime Client with the same capabilities and roots | R2; direct Profile path retained until parity gate |
| GUI process transport | `framework/gui/src/main/profile-cli.ts`, `global-work-observer-host.ts` | Main process owns CLI/observer transports, while Work Dashboard Profile calls remain separate | embedded or loopback transport must share one envelope | R2 implementation and reconnect qualification |
| Agent discovery and control | `framework/core/src/python/kungfu/agent/kfd3_api.registry.json`, `agent/commands.json` | Agent surface advertises Work CLI commands and SessionAttempt binding; it does not own a separate writer | capability discovery and Runtime Client command submission | R3 catalog and command convergence |
| KFX Work contribution | `extensions/work-control/actions/registry.json`, `collaboration/interface.json`, `profile.json`; `framework/kfx/src/index.ts` | KFX contributes Profile actions/views and resolves the same adapter, but its boundary is Profile-specific | KFX Runtime Client capability subset; no direct storage mutation | R3 contribution adapter and reverse scan |
| Legacy vocabulary and readers | `cli/commands/assignment.py::_profile_source`; `domain/compatibility/mission_control_v3*.py`; Work Dashboard/TUI compatibility projections | `work-control` Profile and Mission/Go identities remain read-only compatibility surfaces; exact sealed roots cannot be reinterpreted | compatibility readers, client-edge aliases, explicit deletion gate | retain until exact successor evidence |
| Physical Home persistence | `KF-ADR-019f86da-4f90-713d-8626-d70bca82cb76`; `framework/core/src/python/kungfu/storage/service.py` | `.kungfu` contains durable, ephemeral, and rebuildable classes and is private implementation state | Local Runtime backing only; `publicPathContract=false` | R1 adapter owns it; callers never do |

## Authority and migration risks

| Risk | Current evidence | Contract fence | Status |
| --- | --- | --- | --- |
| GUI/CLI/KFX add separate backend adapters | clients enter at different Profile/CLI layers | one realm writer; caller storage mutation returns `authority-bypass` | contract-proved, implementation deferred |
| stale UI or Agent command overwrites newer state | phase transition has `expected_phase`, but no shared public revision envelope | every command carries `expectedRevision`; mismatch is `stale-revision` | contract-proved, R1 adapter deferred |
| retry duplicates a fact | existing actions have content/root semantics but clients lack one common idempotency contract | same key/body replays original receipt; changed body is `idempotency-conflict` | contract-proved, runtime retention deferred |
| reconnect silently skips events | no shared Assignment client event cursor exists | rooted cursor plus `event-resume-gap` and recovery snapshot | contract-proved, watch implementation deferred |
| legacy Mission/Go identity is rewritten | compatibility modules retain original worlds and roots | reader-only aliases; no root reinterpretation or legacy write | existing source proved and retained |
| `.kungfu` becomes a public file API | current CLI and ports pass runtime paths internally | public envelopes forbid backend paths; Local backing stays private | contract-proved, direct-path removal deferred |
| future Cluster work is inferred from an abstract API | no Cluster Assignment Runtime exists | cluster transport is `future-replaceable-adapter-only`; explicit non-claims | proved absent at R0 |

## Runnable fixture matrix

| Case | Expected contract behavior |
| --- | --- |
| `snapshot-success` | same realm generation, revision, roots, Fact/Episode refs, and receipt are returned |
| `stale-revision` | command fails before mutation with `stale-revision` |
| `duplicate-command-replay` | original receipt root returns with `disposition=replayed` |
| `unsupported-capability` | negotiation is bounded and fails with `unsupported-capability` |
| `malformed-identity` | malformed realm identity is rejected before dispatch |
| `ambiguous-identity` | legacy alias ambiguity is visible and never guessed |
| `backend-unavailable` | no direct-writer fallback; diagnostics name recovery operations |
| `event-resume-gap` | expired cursor returns a recovery snapshot revision |
| `authority-bypass` | backend-specific caller mutation is rejected |

## R0 reconciliation

| Acceptance area | State | Evidence or residual |
| --- | --- | --- |
| Source inventory across Assignment, Home, GUI, CLI, Agent, KFX, compatibility, and folds | proved | matrix above at the pinned source commit |
| Versioned transport/backend-neutral contract | proved | contract, ADR, registry discovery |
| Request/response types, capabilities, reads, watch, commands, CAS, attempts, leases/Warrants, roots, receipts, diagnostics, recovery | proved as contract | JSON Schema plus semantic validator |
| Positive and required negative fixtures without real Home mutation | proved | in-memory Node test suite |
| Local Runtime Profile server/client | missing by design | bounded R1 residual |
| GUI-only Runtime Client path | missing by design | bounded R2 residual |
| CLI/Agent/KFX convergence and final reverse scan | missing by design | bounded R3 residual |
| Cluster Runtime, PostgreSQL, scheduling, HA, capacity | invalid as R0 claims | explicitly out of scope and not started |

No current source assumption was invalidated. The audit did invalidate one
possible planning shortcut: sharing a Profile authority does not mean clients
already share one Runtime API, because their path resolution, invocation,
projection, and retry boundaries remain different.
