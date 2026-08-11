---
name: kungfu-agent-onboarding
description: Use when a user asks to understand, start, inspect, extend, or safely operate installed Kungfu; verify the installed pack, select one intent route, personalize the explanation, and propose one smallest safe next action.
---

# Kungfu Agent Onboarding

When `KUNGFU_AGENT_ENVIRONMENT=native-interactive`, treat the injected
Console/Skill/WorkRef envelopes as discovery pointers, never as prior chat or
completion proof. Confirm them with `"$KUNGFU_CLI_BIN" agent console current
--json`, `"$KUNGFU_CLI_BIN" agent bootstrap-status --json`, and
`"$KUNGFU_CLI_BIN" skill catalog --json`. Keep the provider UI available when
bootstrap is pending or degraded, but do not create, bind, or mutate Work until
bootstrap is verified. Before the first Work
mutation, bind the chosen Assignment with `"$KUNGFU_CLI_BIN" agent console
bind-work --initiative-id <id> --assignment-id <id> --json`; stop unless the
result is `status: bound`, including when another native writer is active.

Run `kungfu agent brief`. Treat the invocation that returned the brief as the
only brief execution for that response; do not run it again.

When an unfamiliar user naturally asks to understand, start, try, or be led
through Kungfu, run exactly one standalone `kungfu agent first-value start
--json`; do not load the full intent map or separately run the docs verifier,
contract, discovery, or receipt commands on this bounded path. The user does
not need to spell out the protocol. The command verifies the installed pack,
runs the declared zero-question read-only onboarding discovery without a shell,
and emits one rooted receipt. Let its JSON print directly, without capture,
redirection, a pipe, or a reprint. When that receipt says
`agentResponseGuide.protocolComplete: true`, run no more commands and do not
explain, extend, paraphrase, omit, reorder, or ask a question. Render only its
`agentResponseGuide.answerTemplate`, replacing the sole `{receiptRoot}` token
with the exact top-level `receiptRoot`. Compare the replacement byte-for-byte
before answering; do not substitute a candidate, contract, or other root. Do
not retain a raw transcript or treat model prose as proof.
For other requests, run `kungfu agent docs --verify --json` and `kungfu agent
map --json`, then select only the relevant route.
Outside that completed first-value path, name one user-supplied or
workspace-visible personalization basis, then include one copyable read-only
verification command, one concrete safe next step, and the
candidate/provider/platform/public-release non-claims.

When durable Work may reduce continuity, handoff, evidence, duplicate retry,
or external-write risk, submit only bounded structured signals to `kungfu agent
work-advisory --signals <signals.json> --json`. Never include a transcript,
hidden reasoning, credentials, or unrelated context. For `recommend`, show the
returned preview and ask its single confirmation. Only after confirmation use
the returned existing `kungfu.work.capture`, `kungfu.work.admit`, and
`kungfu.agent.console.bind-work` path, cite its receipts, and continue the
original task. Suppress a decline for the returned evidence root until the
structured evidence changes. Advice grants no external authority.

For Skill reuse or creation, send only rooted catalog/Work/requirements evidence,
candidate roots, enums, and booleans to `kungfu agent skill-advisory --signals
<signals.json> --json`. Consume its shared policy root
`sha256:dc8ebb873760e55c40ef19b8354ba1e2b91706064a48dec00b1eb8dac0479267`;
do not reproduce the decision policy in provider prose. The result is read-only.

Use `kungfu agent context --task "<task>" --role <role> --budget <tokens>
--route <route-id> --json` when detail is needed. Stop on invalid roots,
ambiguity, stale state, or required omissions; use returned expansion handles
instead of loading the whole corpus.

Explain Kungfu in terms of what is already known about the user and workspace,
without claiming hidden knowledge. Offer one read-only or preview-first action.
Never infer authority from this Skill: writes require their public `--execute`
or authorization path, and Work completion requires native receipts.
