# Cross-language native authority membrane

This document is a generated projection of
[`kungfu-work-lifecycle-operation-matrix.contract.json`](../../framework/work/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json).
Do not edit the table by hand. Cut semantics come from
[`work-lifecycle.contract.json`](../../framework/work/project-cut/work-lifecycle.contract.json),
Episode semantics come from
[`native-operation-catalog.contract.json`](../../framework/core/episode/native-operation-catalog.contract.json),
and the matrix retains their routing, parity, and availability metadata. Run
the matrix materializer before rerendering this document.

The matrix separates **authority availability** from **language-envelope
state**. Only Native Runtime decides operation semantics. A `projected`
language surface transports the native envelope without becoming an authority;
it does **not** prove that the backing operation is available. `unsupported`,
`unavailable`, `degraded`, `stale`, and `unknown` remain explicit and
must never be coerced to false, absent, empty, healthy, or passed.

| Stable operation id | Layer | Capability | Domain authority | Authority availability | Current native route | Language-envelope state |
| --- | --- | --- | --- | --- | --- | --- |
| `work.lifecycle.fact.inspect/v1` | fact | inspect | libkungfu-ledger-action-v1 | **implemented** | implemented: kf_ledger_action_api_v1<br>fact_query | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.fact.create/v1` | fact | create | fact-kernel | **implemented** | implemented: kf_ledger_action_api_v1<br>fact_kernel | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.fact.update/v1` | fact | update | fact-kernel | **implemented** | implemented: kf_ledger_action_api_v1<br>fact_kernel | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.fact.transition/v1` | fact | transition | fact-kernel | **implemented** | implemented: kf_ledger_action_api_v1<br>fact_kernel | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.fact.export/v1` | fact | export | libkungfu-ledger-action-v1 | **implemented** | implemented: kf_ledger_action_api_v1<br>fact_library_export | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.fact.import/v1` | fact | import | libkungfu-ledger-action-v1 | **implemented** | implemented: kf_ledger_action_api_v1<br>fact_library_import | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.fact.verify/v1` | fact | verify | libkungfu-maintenance-v1 | **implemented** | implemented: kf_maintenance_api_v1<br>fsck | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.episode.inspect/v1` | episode | inspect | libkungfu-ledger-action-v1 | **implemented** | implemented: kf_ledger_action_api_v1<br>episode_list, episode_inspect | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.episode.create/v1` | episode | create | libkungfu-ledger-action-v1 | **implemented** | implemented: kf_ledger_action_api_v1<br>episode_begin | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.episode.update/v1` | episode | update | libkungfu-ledger-action-v1 | **implemented** | implemented: kf_ledger_action_api_v1<br>episode_attach_frame, episode_attach_ref | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.episode.transition/v1` | episode | transition | libkungfu-ledger-action-v1 | **implemented** | implemented: kf_ledger_action_api_v1<br>episode_end, episode_abort | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.episode.recover/v1` | episode | recover | libkungfu-ledger-action-v1 | **implemented** | implemented: kf_ledger_action_api_v1<br>episode_recover, episode_recovery_plan, episode_recovery_execute | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.episode.export/v1` | episode | export | libkungfu-ledger-action-v1 | **implemented** | implemented: kf_ledger_action_api_v1<br>authority_export | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.episode.import/v1` | episode | import | libkungfu-ledger-action-v1 | **implemented** | implemented: kf_ledger_action_api_v1<br>authority_import | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.action-geometry.inspect/v1` | action-geometry | inspect | action-geometry-contract | **declarative** | declarative: contract-registry | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.initiative.inspect/v1` | initiative | inspect | work-control-profile | **projected** | projected: work-control-profile<br>initiatives | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.initiative.create/v1` | initiative | create | work-control-profile | **projected** | projected: work-control-actions<br>create-initiative | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.initiative.transition/v1` | initiative | transition | work-control-profile | **projected** | projected: work-control-actions<br>assess-progress, review-completion, decide-continuation | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.initiative.export/v1` | initiative | export | work-control-profile | **projected** | projected: work-control-actions<br>export-initiative | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.initiative.import/v1` | initiative | import | work-control-profile | **projected** | projected: work-control-actions<br>import-initiative | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.assignment.inspect/v1` | assignment | inspect | work-control-profile | **projected** | projected: work-control-profile<br>assignments | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.assignment.create/v1` | assignment | create | work-control-profile | **projected** | projected: work-control-actions<br>create-assignment | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.assignment.transition/v1` | assignment | transition | work-control-profile | **projected** | projected: work-control-actions<br>claim-completion, review-completion | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.assignment.archive/v1` | assignment | archive | work-control-profile | **unavailable** | missing: work-control-actions | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.cut.inspect/v1` | cut | inspect | core-cut-protocol | **implemented** | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.cut.create/v1` | cut | create | domain-profile-cut-authority | **implemented** | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.cut.verify/v1` | cut | verify | core-cut-protocol | **implemented** | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.cut.settle/v1` | cut | settle | domain-profile-cut-authority | **implemented** | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.cut.recover/v1` | cut | recover | domain-profile-cut-authority | **implemented** | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.cut.archive/v1` | cut | archive | domain-profile-cut-authority | **implemented** | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.inspect/v1` | domain-profile | inspect | libkungfu-profile-lifecycle | **implemented** | implemented: kungfu::runtime::profile::profile_lifecycle<br>inspect_profile | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.validate/v1` | domain-profile | validate | kfx-profile-authoring | **unavailable** | missing: domain-profile-authoring-verifier<br>validate | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.register/v1` | domain-profile | register | libkungfu-kfx-registry | **projected** | projected: kungfu::runtime::kfx::native_kfx_service<br>resolve | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.qualify/v1` | domain-profile | qualify | kungfu-profile-qualification | **projected** | projected: kungfu.profile_sdk<br>qualify_source | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.install/v1` | domain-profile | install | libkungfu-profile-lifecycle | **implemented** | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.activate/v1` | domain-profile | activate | libkungfu-profile-lifecycle | **implemented** | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.deactivate/v1` | domain-profile | deactivate | libkungfu-profile-lifecycle | **projected** | projected: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.upgrade/v1` | domain-profile | upgrade | libkungfu-profile-lifecycle | **implemented** | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.rollback/v1` | domain-profile | rollback | libkungfu-profile-lifecycle | **implemented** | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.export/v1` | domain-profile | export | kungfu-profile-source-bundle | **unavailable** | missing: kungfu.profile_sdk<br>export_source_bundle | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |
| `work.lifecycle.domain-profile.import/v1` | domain-profile | import | kungfu-profile-source-bundle | **unavailable** | missing: kungfu.profile_sdk<br>authorized_source_import | cpp=projected<br>python=projected<br>node=projected<br>rust=projected |

## Authority boundaries

- Fact authority owns immutable reality records, Fact Cuts, ref CAS, and Fact receipts; no Profile or Core Cut layer may replace it.
- Episode authority owns causal occurrence and seal/recovery evidence; an accepted action or completion claim is not an Episode.
- Action Geometry owns responsibility separation and non-substitution invariants, while Domain Profiles own lifecycle vocabulary and validation.
- Domain Profile declarations own adopter-specific objects, mappings, workflows, and policies; Core owns installed roots and lifecycle mutation receipts.
- Initiative and Assignment are Work Control domain facts over Core authority; storage capability alone grants no domain authority.
- Core Cut binds typed authority roots without domain special cases; the software-development Profile alone maps Git source, Xinfa Atlas, and Episode roots into its Project Cut projection.
- A language marked partial or missing must fail visibly; backend access, private layout access, or a locally reconstructed state cannot upgrade parity.

## Non-claims

- Equal C++, Python, Node.js, and Rust envelope parity means every underlying Domain Profile authority is available.
- Project Cut is a second Core protocol or may reinterpret legacy project.cut/v1 roots.
- Work Control domain lifecycle is implied by generic Fact or Episode storage operations.
- A generated language binding may use a backend-specific implementation as equivalent authority.
- A valid Domain Profile declaration is signed, qualified, installed, active, or safe for production use.
- The pre-stable lifecycle operation rename silently changes persisted roots, schemas, or receipt identities.
