# Optional real GitHub webhook canary

The maintained qualification is fully offline. A real canary is optional and
must use a user-approved HTTPS endpoint or local webhook proxy that terminates
TLS before forwarding to the loopback-only KFX listener.

1. Install and qualify `github-webhook-ingress` through the public Kungfu Agent
   path. Grant only `credential.verify` and loopback `network.listen`.
2. Store the GitHub webhook secret in the platform credential broker as
   `credential:github/webhook`; never place it in the manifest, environment
   committed to Git, command history, logs, or receipts.
3. Configure exactly one allowed repository and subscribe only to `issues` and
   `issue_comment`. Use JSON content type and the ingress path
   `/github/events`.
4. Send a GitHub test delivery, inspect the `202` acknowledgment and normalized
   evidence, then use GitHub's delivery UI/API for any deliberate redelivery.
5. Remove the external HTTPS route after the canary. Rotate or invalidate the
   credential handle and verify old signatures fail closed.

Do not expose the fixture listener directly, do not disable signature checks,
and do not install the optional Dogfood bridge unless its exact dependency and
Finding capture grant are intentionally admitted.
