# GitHub Webhook Ingress

An ordinary service KFX generated through the installed Kungfu authoring kit.
It layers GitHub's documented webhook headers and event semantics over the
provider-neutral service host without adding GitHub rules to Core.

The listener is loopback-only by default. Production routing must terminate
HTTPS outside this fixture and requires an explicit `network.listen` grant.
Signature verification uses `X-Hub-Signature-256` through the opaque
`credential:github/webhook` handle. Request bytes, signatures, and credential
material are never retained; normalized observations keep only narrow fields
and content roots.

Only `issues` and `issue_comment` are supported, with explicit repository and
action allowlists supplied by the installer. Accepted intake enqueues bounded
asynchronous processing and returns `202`; no-op decisions and failures remain
inspectable through stable evidence codes. `X-GitHub-Delivery` remains the
replay identity across host crash/restart. The service accepts an injected,
bounded delivery store so a runtime can retain only delivery IDs across process
recovery without retaining headers, payloads, signatures, or credentials.

Run the installed-only path:

```sh
kungfu kfx author inspect . --json
kungfu kfx author validate . --json
kungfu kfx author build . --out ./dist/github-webhook-ingress --execute --json
kungfu kfx author qualify . --json
kungfu kfx author package . --out ./dist/github-webhook-ingress.tgz --execute --json
```

The qualification uses generated, in-memory HMAC key material and synthetic
payloads. It never opens a public listener or contacts GitHub.
