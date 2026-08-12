---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
period: 2026-08
theme: kfx-webhook-agent-authoring
doc_type: runbook
sources: [local-files, official-upstream, user-consensus]
confidence: high
sensitivity: internal
evidence_grade: A
review_state: unreviewed
last_reviewed: 2026-08-10
ai_provenance: GPT-5 via Codex on 2026-08-10; based on local canary code and linked official GitHub and AWS documentation; hidden model checkpoints and unobserved cloud execution are not claimed
---

# Real GitHub webhook canary

The maintained suite always runs the fully offline qualification. Terminal
qualification additionally runs this one-shot real GitHub canary in one
environment. It creates no Issue, comment, branch, or commit: GitHub sends the
automatic `ping` delivery produced when the temporary repository webhook is
created.

The canary uses a temporary API Gateway HTTP API in front of a temporary
Lambda. It derives the AWS ARN partition from the selected region; the current
real witness targets `us-east-1`. The Lambda accepts only `POST` GitHub `ping`
requests with a bounded body, delivery ID, and valid `X-Hub-Signature-256`; it
never logs or returns the payload, signature, or secret.

## Preflight and plan

Invalidate any credential previously exposed by diagnostics before continuing.
Then verify the intended GitHub repository, AWS region, and temporary OIDC
caller identity through read-only checks. Do not use long-lived AWS access keys
and do not call Lambda configuration/list APIs. The default invocation only
prints a rooted plan:

```sh
./shifu qualify:kfx-github-webhook-real-canary -- \
  --repo OWNER/REPO \
  --region us-east-1
```

The plan names every resource class and the teardown/absence checks. It does
not contact GitHub or AWS.

## Execute once

```sh
./shifu qualify:kfx-github-webhook-real-canary -- \
  --execute \
  --confirm-credential-rotation \
  --repo OWNER/REPO \
  --region us-east-1 \
  --report product/release/qualification/kfx-webhook-real-canary.json
```

The tool generates a synthetic one-use HMAC secret in memory, passes it to AWS
and GitHub through private temporary JSON files or standard input, polls only
delivery metadata, and accepts exactly a GitHub `ping` with HTTP `202`.

## Automatic teardown and retained evidence

Success and failure both enter teardown. The exact temporary repository
webhook, HTTP API, Lambda function, IAM role, and Lambda log group are removed.
The tool then verifies the hook, API, Lambda function, role, and log group are
absent. Function absence is proved by a second exact-name delete returning
`ResourceNotFoundException`; the tool does not call Lambda configuration/list
APIs during verification, so unrelated function environment variables cannot
enter output.

The receipt retains only region/repository coordinates, plan and evidence
roots, the hashed delivery identity, the `202` result, and zero-residue
booleans. It retains no public endpoint, secret, signature, or payload.

If execution fails, use the random resource names printed by the plan/error
context only for exact-target read-only inspection. Do not delete similarly
named resources. A missing or unverified absence check is a failed canary, not
a waiver.

## Product runtime route

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

References: [GitHub repository webhook REST API](https://docs.github.com/en/rest/repos/webhooks),
[AWS API Gateway v2 create-api](https://docs.aws.amazon.com/cli/latest/reference/apigatewayv2/create-api.html),
and [AWS IAM OIDC roles](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html).
