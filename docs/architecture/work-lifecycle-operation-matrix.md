# Work lifecycle operation matrix

This document is a generated projection of
[`kungfu-work-lifecycle-operation-matrix.contract.json`](../../framework/work-lifecycle/kungfu-work-lifecycle-operation-matrix.contract.json).
Edit the machine contract and rerun the renderer; do not edit the table by hand.

The matrix separates current evidence from the common four-language target.
`proved` means the repository contains a checked public path to the declared
authority. `partial` means a host or substrate exists but the full public
lifecycle operation is not proved. `missing` is an explicit gap.
`not-applicable` records a current declarative surface; it does not waive the
target requirement.

| Stable operation id | Layer | Capability | Sole authority owner | Current native route | Current language parity |
| --- | --- | --- | --- | --- | --- |
| `work.lifecycle.fact.inspect/v1` | fact | inspect | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>fact_query | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.fact.create/v1` | fact | create | fact-kernel | implemented: kf_ledger_action_api_v1<br>fact_kernel | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.fact.update/v1` | fact | update | fact-kernel | implemented: kf_ledger_action_api_v1<br>fact_kernel | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.fact.transition/v1` | fact | transition | fact-kernel | implemented: kf_ledger_action_api_v1<br>fact_kernel | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.fact.export/v1` | fact | export | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>fact_library_export | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.fact.import/v1` | fact | import | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>fact_library_import | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.fact.verify/v1` | fact | verify | libkungfu-maintenance-v1 | implemented: kf_maintenance_api_v1<br>fsck | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.episode.inspect/v1` | episode | inspect | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>episode_list, episode_inspect | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.episode.create/v1` | episode | create | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>episode_begin | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.episode.update/v1` | episode | update | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>episode_attach_frame, episode_attach_ref | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.episode.transition/v1` | episode | transition | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>episode_end, episode_abort | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.episode.recover/v1` | episode | recover | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>episode_recover, episode_recovery_plan, episode_recovery_execute | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.episode.export/v1` | episode | export | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>authority_export | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.episode.import/v1` | episode | import | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>authority_import | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.action-geometry.inspect/v1` | action-geometry | inspect | action-geometry-contract | declarative: contract-registry | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.initiative.inspect/v1` | initiative | inspect | mission-control-profile | projected: mission-control-profile<br>show-missions | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.initiative.create/v1` | initiative | create | mission-control-profile | projected: mission-control-actions<br>create-initiative | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.initiative.transition/v1` | initiative | transition | mission-control-profile | projected: mission-control-actions<br>assess-progress, review-completion, decide-continuation | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.initiative.export/v1` | initiative | export | mission-control-profile | projected: mission-control-actions<br>export-mission | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.initiative.import/v1` | initiative | import | mission-control-profile | projected: mission-control-actions<br>import-mission | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.assignment.inspect/v1` | assignment | inspect | mission-control-profile | projected: mission-control-profile<br>show-goals | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.assignment.create/v1` | assignment | create | mission-control-profile | projected: mission-control-actions<br>create-assignment | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.assignment.transition/v1` | assignment | transition | mission-control-profile | projected: mission-control-actions<br>claim-completion, review-completion | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.assignment.archive/v1` | assignment | archive | mission-control-profile | missing: mission-control-actions | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.cut.inspect/v1` | cut | inspect | core-cut-protocol | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.cut.create/v1` | cut | create | domain-profile-cut-authority | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.cut.verify/v1` | cut | verify | core-cut-protocol | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.cut.settle/v1` | cut | settle | domain-profile-cut-authority | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.cut.recover/v1` | cut | recover | domain-profile-cut-authority | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.cut.archive/v1` | cut | archive | domain-profile-cut-authority | implemented: kf_runtime_action_api_v1<br>work_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.inspect/v1` | domain-profile | inspect | libkungfu-profile-lifecycle | implemented: kungfu::runtime::profile::profile_lifecycle<br>inspect_profile | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.validate/v1` | domain-profile | validate | kfx-profile-authoring | missing: domain-profile-authoring-verifier<br>validate | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.register/v1` | domain-profile | register | libkungfu-kfx-registry | projected: kungfu::runtime::kfx::native_kfx_service<br>resolve | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.qualify/v1` | domain-profile | qualify | kungfu-profile-qualification | projected: kungfu.profile_sdk<br>qualify_source | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.install/v1` | domain-profile | install | libkungfu-profile-lifecycle | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.activate/v1` | domain-profile | activate | libkungfu-profile-lifecycle | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.deactivate/v1` | domain-profile | deactivate | libkungfu-profile-lifecycle | projected: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.upgrade/v1` | domain-profile | upgrade | libkungfu-profile-lifecycle | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.rollback/v1` | domain-profile | rollback | libkungfu-profile-lifecycle | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.export/v1` | domain-profile | export | kungfu-profile-source-bundle | missing: kungfu.profile_sdk<br>export_source_bundle | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |
| `work.lifecycle.domain-profile.import/v1` | domain-profile | import | kungfu-profile-source-bundle | missing: kungfu.profile_sdk<br>authorized_source_import | cpp=proved<br>python=proved<br>node=proved<br>rust=proved |

## Authority boundaries

- Fact authority owns immutable reality records, Fact Cuts, ref CAS, and Fact receipts; no Profile or Core Cut layer may replace it.
- Episode authority owns causal occurrence and seal/recovery evidence; an accepted action or completion claim is not an Episode.
- Action Geometry owns responsibility separation and non-substitution invariants, while Domain Profiles own lifecycle vocabulary and validation.
- Domain Profile declarations own adopter-specific objects, mappings, workflows, and policies; Core owns installed roots and lifecycle mutation receipts.
- Initiative and Assignment are Mission Control domain facts over Core authority; storage capability alone grants no domain authority.
- Core Cut binds typed authority roots without domain special cases; the software-development Profile alone maps Git source, Xinfa Atlas, and Episode roots into its Project Cut projection.
- A language marked partial or missing must fail visibly; backend access, private layout access, or a locally reconstructed state cannot upgrade parity.

## Non-claims

- Equal C++, Python, Node.js, and Rust envelope parity means every underlying Domain Profile authority is available.
- Project Cut is a second Core protocol or may reinterpret legacy project.cut/v1 roots.
- Mission Control domain lifecycle is implied by generic Fact or Episode storage operations.
- A generated language binding may use a backend-specific implementation as equivalent authority.
- A valid Domain Profile declaration is signed, qualified, installed, active, or safe for production use.
- The pre-stable lifecycle operation rename silently changes persisted roots, schemas, or receipt identities.
