# GitHub Webhook KFX reference suite

A maintained ordinary-public KFX example with three separable components:

- `github-webhook-ingress`: authenticated, bounded GitHub intake and normalized
  asynchronous observations;
- `github-event-view`: local inspection of receipt, normalization, no-op,
  rejection, and replay evidence without Dogfood;
- `github-dogfood-bridge`: optional exact-authority conversion of an
  observation into one immutable Dogfood Finding capture.

The ingress and view are required suite members. The bridge is optional and
fails dormant, so installing or removing Dogfood cannot break generic webhook
learning. GitHub events are observations only; no component admits Dogfood
Issues, creates or completes Work, mutates GitHub, or claims semantic
completion.

Both services were scaffolded from the installed version-matched authoring kit
and retain its exact SDK projection. See each component README for the public
Agent-first qualification commands and `docs/optional-real-github-canary.md`
for the deliberately optional HTTPS canary.
