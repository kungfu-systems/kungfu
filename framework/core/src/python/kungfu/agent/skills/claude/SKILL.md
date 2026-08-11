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

Run `kungfu agent brief`, then `kungfu agent docs --verify --json` and
`kungfu agent map --json`. Select only the route relevant to the user's task.

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
