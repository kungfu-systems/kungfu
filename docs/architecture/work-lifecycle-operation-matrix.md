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
| `work.lifecycle.fact.inspect/v1` | fact | inspect | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>fact_query | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.fact.create/v1` | fact | create | fact-kernel | implemented: kf_ledger_action_api_v1<br>fact_kernel | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.fact.update/v1` | fact | update | fact-kernel | implemented: kf_ledger_action_api_v1<br>fact_kernel | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.fact.transition/v1` | fact | transition | fact-kernel | implemented: kf_ledger_action_api_v1<br>fact_kernel | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.fact.export/v1` | fact | export | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>fact_library_export | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.fact.import/v1` | fact | import | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>fact_library_import | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.fact.verify/v1` | fact | verify | libkungfu-maintenance-v1 | implemented: kf_maintenance_api_v1<br>fsck | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.episode.inspect/v1` | episode | inspect | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>episode_list, episode_inspect | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.episode.create/v1` | episode | create | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>episode_begin | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.episode.update/v1` | episode | update | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>episode_attach_frame, episode_attach_ref | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.episode.transition/v1` | episode | transition | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>episode_end, episode_abort | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.episode.recover/v1` | episode | recover | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>episode_recover, episode_recovery_plan, episode_recovery_execute | cpp=proved<br>python=proved<br>node=partial<br>rust=proved |
| `work.lifecycle.episode.export/v1` | episode | export | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>authority_export | cpp=proved<br>python=partial<br>node=partial<br>rust=partial |
| `work.lifecycle.episode.import/v1` | episode | import | libkungfu-ledger-action-v1 | implemented: kf_ledger_action_api_v1<br>authority_import | cpp=proved<br>python=partial<br>node=partial<br>rust=partial |
| `work.lifecycle.action-geometry.inspect/v1` | action-geometry | inspect | action-geometry-contract | declarative: contract-registry | cpp=not-applicable<br>python=partial<br>node=proved<br>rust=not-applicable |
| `work.lifecycle.initiative.inspect/v1` | initiative | inspect | mission-control-profile | projected: mission-control-profile<br>show-missions | cpp=partial<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.initiative.create/v1` | initiative | create | mission-control-profile | projected: mission-control-actions<br>create-initiative | cpp=partial<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.initiative.transition/v1` | initiative | transition | mission-control-profile | projected: mission-control-actions<br>assess-progress, review-completion, decide-continuation | cpp=partial<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.initiative.export/v1` | initiative | export | mission-control-profile | projected: mission-control-actions<br>export-mission | cpp=partial<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.initiative.import/v1` | initiative | import | mission-control-profile | projected: mission-control-actions<br>import-mission | cpp=partial<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.assignment.inspect/v1` | assignment | inspect | mission-control-profile | projected: mission-control-profile<br>show-goals | cpp=partial<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.assignment.create/v1` | assignment | create | mission-control-profile | projected: mission-control-actions<br>create-assignment | cpp=partial<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.assignment.transition/v1` | assignment | transition | mission-control-profile | projected: mission-control-actions<br>claim-completion, review-completion | cpp=partial<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.assignment.archive/v1` | assignment | archive | mission-control-profile | missing: mission-control-actions | cpp=missing<br>python=missing<br>node=missing<br>rust=missing |
| `work.lifecycle.project-cut.inspect/v1` | project-cut | inspect | project-cut-protocol | missing: project-cut-mjs<br>inspect | cpp=missing<br>python=missing<br>node=proved<br>rust=missing |
| `work.lifecycle.project-cut.create/v1` | project-cut | create | project-cut-settlement | missing: project-cut-mjs<br>prepare | cpp=missing<br>python=missing<br>node=proved<br>rust=missing |
| `work.lifecycle.project-cut.verify/v1` | project-cut | verify | project-cut-protocol | missing: project-cut-mjs<br>verify | cpp=missing<br>python=missing<br>node=proved<br>rust=missing |
| `work.lifecycle.project-cut.settle/v1` | project-cut | settle | project-cut-settlement | missing: project-cut-mjs<br>commit-observe | cpp=missing<br>python=missing<br>node=proved<br>rust=missing |
| `work.lifecycle.project-cut.recover/v1` | project-cut | recover | project-cut-settlement | missing: project-cut-mjs<br>reconcile | cpp=missing<br>python=missing<br>node=proved<br>rust=missing |
| `work.lifecycle.project-cut.archive/v1` | project-cut | archive | project-cut-settlement | missing: project-cut-mjs<br>abandon | cpp=missing<br>python=missing<br>node=proved<br>rust=missing |
| `work.lifecycle.domain-profile.inspect/v1` | domain-profile | inspect | libkungfu-profile-lifecycle | implemented: kungfu::runtime::profile::profile_lifecycle<br>inspect_profile | cpp=proved<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.domain-profile.validate/v1` | domain-profile | validate | kfx-profile-authoring | missing: domain-profile-authoring-verifier<br>validate | cpp=missing<br>python=missing<br>node=proved<br>rust=missing |
| `work.lifecycle.domain-profile.register/v1` | domain-profile | register | libkungfu-kfx-registry | projected: kungfu::runtime::kfx::native_kfx_service<br>resolve | cpp=partial<br>python=partial<br>node=partial<br>rust=missing |
| `work.lifecycle.domain-profile.qualify/v1` | domain-profile | qualify | kungfu-profile-qualification | projected: kungfu.profile_sdk<br>qualify_source | cpp=partial<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.domain-profile.install/v1` | domain-profile | install | libkungfu-profile-lifecycle | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=proved<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.domain-profile.activate/v1` | domain-profile | activate | libkungfu-profile-lifecycle | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=proved<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.domain-profile.deactivate/v1` | domain-profile | deactivate | libkungfu-profile-lifecycle | projected: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=partial<br>python=partial<br>node=missing<br>rust=missing |
| `work.lifecycle.domain-profile.upgrade/v1` | domain-profile | upgrade | libkungfu-profile-lifecycle | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=proved<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.domain-profile.rollback/v1` | domain-profile | rollback | libkungfu-profile-lifecycle | implemented: kungfu::runtime::profile::profile_lifecycle<br>apply_profile_lifecycle | cpp=proved<br>python=proved<br>node=partial<br>rust=missing |
| `work.lifecycle.domain-profile.export/v1` | domain-profile | export | kungfu-profile-source-bundle | missing: kungfu.profile_sdk<br>export_source_bundle | cpp=missing<br>python=proved<br>node=missing<br>rust=missing |
| `work.lifecycle.domain-profile.import/v1` | domain-profile | import | kungfu-profile-source-bundle | missing: kungfu.profile_sdk<br>authorized_source_import | cpp=missing<br>python=proved<br>node=missing<br>rust=missing |

## Authority boundaries

- Fact authority owns immutable reality records, Cuts, ref CAS, and Fact receipts; no Profile or Project Cut layer may replace it.
- Episode authority owns causal occurrence and seal/recovery evidence; an accepted action or completion claim is not an Episode.
- Action Geometry owns responsibility separation and non-substitution invariants, while Domain Profiles own lifecycle vocabulary and validation.
- Domain Profile declarations own adopter-specific objects, mappings, workflows, and policies; Core owns installed roots and lifecycle mutation receipts.
- Initiative and Assignment are Mission Control domain facts over Core authority; storage capability alone grants no domain authority.
- Project Cut binds source, Atlas, and Episode roots and observes publication; it owns none of those upstream authorities and never commits or pushes.
- A language marked partial or missing must fail visibly; backend access, private layout access, or a locally reconstructed state cannot upgrade parity.

## Non-claims

- Current C++, Python, Node.js, and Rust surfaces have equal lifecycle coverage.
- Project Cut currently has a native libkungfu authority surface.
- Mission Control domain lifecycle is implied by generic Fact or Episode storage operations.
- A missing language binding may use a backend-specific implementation as equivalent authority.
- A valid Domain Profile declaration is signed, qualified, installed, active, or safe for production use.
- This matrix changes existing operation names, persisted roots, schemas, or receipt identities.
