# GitHub Dogfood Bridge

An optional service KFX that consumes only normalized
`kungfu.github-webhook-observation/v1` records. It does not own GitHub ingress
and its absence never affects the ingress or event view.

The bridge is available only when the exact `kungfu.dogfood-feedback`
dependency is installed, compatible, qualified, authorized, and bound to KFD,
Warrant, Passport, and `dogfood.finding.capture` grant roots. Missing,
incompatible, unqualified, revoked, or unauthorized authority produces a
stable dormant receipt without any effect.

The sole automatic effect is the public capability invocation
`dogfood.finding.capture` with an immutable Finding proposal. The proposal
explicitly denies Issue admission, Work mutation, GitHub mutation, and semantic
completion. The capture ledger is injected through a narrow `has/get/set`
contract, so delivery deduplication survives capability revocation, restore,
and process recovery without retaining raw GitHub payloads.

Run the installed-only authoring path with `kungfu kfx author inspect`,
`validate`, `build`, `qualify`, and `package`. The qualification uses only
synthetic normalized observations and a bounded capability stub.
