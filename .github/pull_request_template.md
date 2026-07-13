<!--
Do not include secrets, credentials, tokens, or private logs.
Write the description in English. Sign commits with the DCO (git commit -s).
-->

## Summary

## Related issue

## Changes

## Verification

## ADR delivery / release declaration

Keep exactly one machine-readable block below. Select the shape for the PR's
target channel and replace the example values. See
`docs/development/version-release-design.md` for the contract and management intent.

<!-- kungfu-adr-release:v1
{
  "schema": "kungfu.adr-release-pr/v1",
  "kind": "adr-neutral",
  "reason": "Describe why this non-feature change does not alter an architecture contract"
}
-->

Feature PRs targeting `dev/*` must replace the block with:

```json
{
  "schema": "kungfu.adr-release-pr/v1",
  "kind": "dev-delivery",
  "intent": "stage-ready",
  "adrs": ["ADR-0000"],
  "summary": "Describe the bounded stage completed by this PR",
  "verification": ["Name the checks or qualification evidence"]
}
```

Alpha and stable promotion manifests are documented in the release design;
do not use the ADR-neutral form for a channel promotion.

## Governance risk check

Does this PR touch any of these boundaries?

- [ ] credentials, tokens, secrets, or private logs
- [ ] provider APIs, CLIs, OpenTelemetry, billing, quota, or usage attribution
- [ ] official hosted or managed services
- [ ] official branding, package names, release identity, or domains
- [ ] release evidence, provenance, package publishing, or deployment surfaces
- [ ] none of the above

If any item is checked, describe the boundary and the verification evidence in
the summary or verification section.

## Checklist

- [ ] Commits are signed off (DCO)
- [ ] Documentation updated if behavior changed
