# Closed-world workflow authority

Kungfu classifies every workflow, job, and step under `.github/workflows` in
[`workflow-authority.json`](./workflow-authority.json). The manifest is an
authority allowlist, not a workflow index assembled from prose. A new workflow,
job, or step is unknown until it is classified; unknown execution fails
`./shifu check:gate-catalog` and therefore source acceptance.

The manifest records a digest of the complete workflow activation surface and
each complete job and step definition. This binds triggers and path filters,
`if`, `needs`, permissions, runner selection, reusable workflow or action refs,
inputs, environment, secrets/OIDC use, shell actions, and step ordering. A
one-sided YAML change is drift even when the command text still looks familiar.

## Authority classes

- `qualification` may produce diagnostic or qualifying test evidence but may
  not publish a product or move a release channel.
- `diagnostic` may update bounded failure reporting, such as the dev patrol
  issue, but never signs a release capability.
- `release-control` may move a declared channel only after the independent
  [release-admission predicate](./release-admission.md) returns a fresh scoped
  capability.
- `product-publication` is the narrow package, registry, or GitHub Release
  write lane. Evidence upload alone remains `evidence-publication` and does not
  become product authority.

An authority-bearing workflow may reference an external action or reusable
workflow only by an immutable 40-character commit SHA. Write, OIDC, repository
secret, inherited-secret, and Environment surfaces are recorded explicitly.
Moving a permission from one job to workflow scope changes the recorded
credential surface and fails the contract.

## Generated inventory

The table below is generated from the machine manifest. Editing it by hand
without changing and refreshing the manifest fails the Gate catalog check.

<!-- BEGIN GENERATED WORKFLOW AUTHORITY MATRIX -->
| Workflow | Job | Authority | Publication | Receipt | Credentials | Environment | Steps |
| --- | --- | --- | --- | --- | --- | --- | ---: |
| `.github/workflows/adr-release-gate.yml` | `adr-release` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/affected-native-cache-promote.yml` | `promote` | qualification | none | diagnostic | token:write | none | 25 |
| `.github/workflows/affected-native-cache-promote.yml` | `qualify_windows_x86_64_consumer` | qualification | none | diagnostic | token:read | none | 5 |
| `.github/workflows/affected-native-pr.yml` | `affected_native` | qualification | none | diagnostic | token:write | none | 20 |
| `.github/workflows/affected-native-pr.yml` | `affected_native_shards` | qualification | none | diagnostic | token:write | none | 18 |
| `.github/workflows/affected-native-pr.yml` | `cancel_after_source_failure` | qualification | none | diagnostic | token:write | none | 1 |
| `.github/workflows/affected-native-pr.yml` | `candidate_buildchain_config` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/affected-native-pr.yml` | `candidate_preflight` | qualification | none | diagnostic | token:read | none | 7 |
| `.github/workflows/affected-native-pr.yml` | `dco` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/affected-native-pr.yml` | `kfd_verifier` | qualification | none | diagnostic | token:write | none | 3 |
| `.github/workflows/affected-native-pr.yml` | `proof_probe` | qualification | none | diagnostic | token:read | none | 10 |
| `.github/workflows/affected-native-pr.yml` | `shifu_workspace` | qualification | none | diagnostic | token:write | none | 3 |
| `.github/workflows/affected-native-pr.yml` | `source_acceptance` | qualification | none | diagnostic | token:read | none | 0 |
| `.github/workflows/affected-native-pr.yml` | `warrant_admission` | qualification | none | diagnostic | token:read | none | 4 |
| `.github/workflows/alpha-promotion-preflight.yml` | `aggregate` | qualification | none | diagnostic | token:read | none | 4 |
| `.github/workflows/alpha-promotion-preflight.yml` | `probe` | qualification | none | diagnostic | token:read | none | 10 |
| `.github/workflows/auditable-demo.yml` | `auditable-demo` | qualification | none | qualifying | token:write, repo-secret:KUNGFU_GITHUB_TOKEN | none | 0 |
| `.github/workflows/auditable-demo.yml` | `build` | qualification | none | qualifying | token:write, oidc | none | 0 |
| `.github/workflows/auditable-demo.yml` | `resolve-binary` | qualification | none | diagnostic | token:read | none | 1 |
| `.github/workflows/aws-us-linux-burst-qualification.yml` | `qualify` | qualification | none | diagnostic | token:read | none | 0 |
| `.github/workflows/aws-us-macos-burst-qualification.yml` | `qualify` | qualification | none | diagnostic | token:write, oidc | none | 0 |
| `.github/workflows/aws-us-windows-burst-qualification.yml` | `cleanup-exercise` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/aws-us-windows-burst-qualification.yml` | `full` | qualification | none | diagnostic | token:write, oidc | none | 0 |
| `.github/workflows/aws-us-windows-burst-qualification.yml` | `smoke` | qualification | none | diagnostic | token:write, oidc | none | 0 |
| `.github/workflows/aws-us-windows-burst-qualification.yml` | `trust` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/build.yml` | `auditable-demo-fast-sentinel` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/build.yml` | `build` | qualification | none | qualifying | token:write, oidc, repo-secret:BUILDCHAIN_ARTIFACT_RELAY_S3_DOWNLOAD_ROLE_ARN+BUILDCHAIN_ARTIFACT_RELAY_S3_ROLE_ARN+BUILDCHAIN_ARTIFACT_RELAY_S3_UPLOAD_ROLE_ARN+KUNGFU_GITHUB_TOKEN | none | 0 |
| `.github/workflows/build.yml` | `kungfu-phase-b` | qualification | none | qualifying | token:read | none | 0 |
| `.github/workflows/build.yml` | `phase-b-package` | qualification | none | diagnostic | token:read | none | 5 |
| `.github/workflows/build.yml` | `precompute-alpha-publication-tail` | qualification | none | diagnostic | token:read | none | 4 |
| `.github/workflows/build.yml` | `preflight` | qualification | none | diagnostic | token:write, oidc, repo-secret:KUNGFU_GITHUB_TOKEN | none | 3 |
| `.github/workflows/build.yml` | `windows-fast-sentinel` | qualification | none | diagnostic | token:read | none | 3 |
| `.github/workflows/buildchain-validate.yml` | `promotion-rehearsal` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/buildchain-validate.yml` | `validate` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/cancel-dequeued-merge-group.yml` | `cancel` | qualification | none | diagnostic | token:write, repo-secret:GITHUB_TOKEN | none | 3 |
| `.github/workflows/core-build-profiles.yml` | `qualify` | qualification | none | diagnostic | token:read | none | 24 |
| `.github/workflows/core-build-profiles.yml` | `shifu_observation` | qualification | none | diagnostic | token:read | none | 4 |
| `.github/workflows/dco.yml` | `signoff` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/dev-alpha-candidate-patrol.yml` | `candidate` | qualification | none | diagnostic | token:write, repo-secret:KUNGFU_GITHUB_TOKEN | none | 0 |
| `.github/workflows/dev-alpha-candidate-patrol.yml` | `candidate-provenance` | qualification | none | diagnostic | token:read | none | 3 |
| `.github/workflows/dev-alpha-candidate-patrol.yml` | `release-cut-lock` | qualification | none | diagnostic | token:read | none | 3 |
| `.github/workflows/dev-alpha-candidate-patrol.yml` | `resolve-channels` | qualification | none | diagnostic | token:none | none | 1 |
| `.github/workflows/dev-delivery-warrant-terminal.yml` | `cancel-queued` | qualification | none | diagnostic | token:write, repo-secret:KUNGFU_GITHUB_TOKEN | none | 0 |
| `.github/workflows/dev-delivery-warrant-terminal.yml` | `close` | qualification | none | diagnostic | token:write, repo-secret:KUNGFU_GITHUB_TOKEN | none | 0 |
| `.github/workflows/dev-delivery-warrant-terminal.yml` | `prepare` | qualification | none | diagnostic | token:write | none | 2 |
| `.github/workflows/dev-gate-latency-patrol.yml` | `capture` | diagnostic | evidence | diagnostic | token:read | none | 5 |
| `.github/workflows/dev-gate-latency-patrol.yml` | `collect` | diagnostic | evidence | diagnostic | token:read | none | 6 |
| `.github/workflows/dev-post-merge-advisory.yml` | `prepare` | qualification | none | diagnostic | token:read | none | 4 |
| `.github/workflows/dev-post-merge-advisory.yml` | `production_graph_parity` | qualification | none | diagnostic | token:read | none | 6 |
| `.github/workflows/dev-post-merge-advisory.yml` | `qualified_core_candidate` | qualification | none | diagnostic | token:read | none | 5 |
| `.github/workflows/dev-pr-auto-merge.yml` | `admission` | qualification | none | diagnostic | token:write, repo-secret:KUNGFU_GITHUB_TOKEN | none | 0 |
| `.github/workflows/dev-pr-auto-merge.yml` | `delivery-contract` | qualification | none | diagnostic | token:read | none | 12 |
| `.github/workflows/dev-pr-auto-merge.yml` | `resolve-target` | qualification | none | diagnostic | token:read | none | 1 |
| `.github/workflows/dev-qualification-patrol.yml` | `patrol` | qualification | none | diagnostic | token:write, repo-secret:KUNGFU_GITHUB_TOKEN | none | 0 |
| `.github/workflows/dev-verify-patrol.yml` | `bind-source` | qualification | none | diagnostic | token:read | none | 1 |
| `.github/workflows/dev-verify-patrol.yml` | `report` | diagnostic | none | none | token:write | none | 1 |
| `.github/workflows/dev-verify-patrol.yml` | `verify` | qualification | none | qualifying | token:write, oidc | none | 0 |
| `.github/workflows/docs-check.yml` | `docs-check` | qualification | none | diagnostic | token:read | none | 3 |
| `.github/workflows/docs-external-links.yml` | `external-links` | qualification | none | diagnostic | token:read, repo-secret:GITHUB_TOKEN | none | 2 |
| `.github/workflows/embedding-membrane-spike.yml` | `native-membrane` | qualification | none | diagnostic | token:read | none | 17 |
| `.github/workflows/embedding-membrane-spike.yml` | `preflight` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/embedding-membrane-spike.yml` | `source-delta` | qualification | none | diagnostic | token:read | none | 3 |
| `.github/workflows/gate-measurement.yml` | `focused` | qualification | none | diagnostic | token:read | none | 7 |
| `.github/workflows/gate-measurement.yml` | `measure` | qualification | none | qualifying | token:read | none | 0 |
| `.github/workflows/gate-measurement.yml` | `python-kfx-asyncio-performance` | qualification | none | diagnostic | token:read | none | 7 |
| `.github/workflows/kfd-verifier-drift.yml` | `verify-owned-fixtures` | qualification | none | qualifying | token:read | none | 4 |
| `.github/workflows/kungfu-agent-patrol.yml` | `patrol` | qualification | none | diagnostic | token:read | none | 9 |
| `.github/workflows/linux-arm64-alpha-qualification.yml` | `artifact` | qualification | none | diagnostic | token:write, oidc, repo-secret:BUILDCHAIN_ARTIFACT_RELAY_S3_DOWNLOAD_ROLE_ARN+BUILDCHAIN_ARTIFACT_RELAY_S3_ROLE_ARN+BUILDCHAIN_ARTIFACT_RELAY_S3_UPLOAD_ROLE_ARN | none | 0 |
| `.github/workflows/linux-arm64-alpha-qualification.yml` | `preflight` | qualification | none | diagnostic | token:write, oidc | none | 2 |
| `.github/workflows/opencode-agent-repository-work.yml` | `experiment` | qualification | none | diagnostic | token:read | none | 5 |
| `.github/workflows/opencode-local-model-canary.yml` | `canary` | qualification | none | diagnostic | token:read | none | 4 |
| `.github/workflows/publish-layer-artifacts.yml` | `prepare` | qualification | none | diagnostic | token:read | none | 11 |
| `.github/workflows/publish-layer-artifacts.yml` | `publish` | product-publication | product | none | token:write, oidc | `adr0049-production-publication` | 9 |
| `.github/workflows/publish-layer-artifacts.yml` | `publish-pypi` | product-publication | product | none | token:write, oidc | `adr0049-production-publication` | 2 |
| `.github/workflows/publish-layer-artifacts.yml` | `verify-portable-format-publication` | qualification | none | diagnostic | token:read | none | 4 |
| `.github/workflows/publish-layer-artifacts.yml` | `verify-publication` | qualification | none | diagnostic | token:read | none | 4 |
| `.github/workflows/python-structure.yml` | `exact-root-ratchet` | qualification | none | diagnostic | token:read | none | 5 |
| `.github/workflows/queue-admission-lease.yml` | `admission` | qualification | none | diagnostic | token:read | none | 5 |
| `.github/workflows/release-new-version.yml` | `alpha-timeline` | qualification | none | diagnostic | token:write | none | 11 |
| `.github/workflows/release-new-version.yml` | `promote` | release-control | channel | qualifying | token:write, oidc, repo-secret:BUILDCHAIN_ISSUE_APP_ID+BUILDCHAIN_ISSUE_APP_PRIVATE_KEY+KUNGFU_ALPHA_CHANNEL_SIGNING_PRIVATE_KEY+KUNGFU_GITHUB_TOKEN+KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY | none | 0 |
| `.github/workflows/release-new-version.yml` | `promotion-contract` | qualification | none | diagnostic | token:read | none | 11 |
| `.github/workflows/release-new-version.yml` | `recover` | release-control | channel | qualifying | token:write, oidc, repo-secret:BUILDCHAIN_ISSUE_APP_ID+BUILDCHAIN_ISSUE_APP_PRIVATE_KEY+KUNGFU_ALPHA_CHANNEL_SIGNING_PRIVATE_KEY+KUNGFU_GITHUB_TOKEN+KUNGFU_GOVERNANCE_AUDITOR_APP_PRIVATE_KEY | none | 0 |
| `.github/workflows/release-new-version.yml` | `recovery-preflight` | qualification | none | diagnostic | token:read | none | 8 |
| `.github/workflows/release-shifu.yml` | `build` | qualification | none | diagnostic | token:write, oidc | none | 7 |
| `.github/workflows/release-shifu.yml` | `release` | product-publication | product | none | token:write, repo-secret:GITHUB_TOKEN | `adr0049-production-publication` | 3 |
| `.github/workflows/report-projection.yml` | `exact-source-projection` | qualification | none | diagnostic | token:read | none | 6 |
| `.github/workflows/shifu-ci.yml` | `check` | qualification | none | diagnostic | token:read | none | 9 |
| `.github/workflows/shifu-ci.yml` | `preflight` | qualification | none | diagnostic | token:read | none | 2 |
| `.github/workflows/source-acceptance.yml` | `source-acceptance` | qualification | none | qualifying | token:read | none | 0 |
| `.github/workflows/stable-candidate-patrol.yml` | `resolve-version-line` | qualification | none | diagnostic | token:write | none | 2 |
| `.github/workflows/stable-candidate-patrol.yml` | `stable` | qualification | none | diagnostic | token:write, repo-secret:KUNGFU_GITHUB_TOKEN | none | 0 |
<!-- END GENERATED WORKFLOW AUTHORITY MATRIX -->

## Change procedure

1. Change the workflow in the same PR as its authority decision.
2. Run `./shifu gate:workflow-authority:refresh` to refresh exact
   definitions. New entries must be reviewed rather than accepted because the
   command generated a digest.
3. Review the credential and publication columns, then run
   `./shifu check:gate-catalog` and `./shifu check:source`.
4. If a job can publish a product or move a channel, update the release
   admission policy and its negative fixtures in the same change.

The refresh command cannot make a mutable action acceptable and cannot turn a
non-publication job into a publication authority. Those are semantic checks,
not generated fields.
