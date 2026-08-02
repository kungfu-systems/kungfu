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

When the user asks to be led through a first useful result, also run
`kungfu agent first-value contract --json`. Ask at most one necessary question,
complete one declared read-only or preview-safe discovery, and give one minimal
outcome.
For the contract's exact prompt, use its zero-question `onboarding` default and
`kungfu agent status --target codex --scope project --json` unless verified
local evidence requires another route.
Then run `kungfu agent first-value receipt --intent <id> --discovery '<command>'
--question-count <0-or-1> --outcome '<bounded-summary>' --json`. Cite its
`receiptRoot`; do not retain a raw transcript or treat model prose as proof.

When durable Work may reduce continuity, handoff, evidence, duplicate retry,
or external-write risk, submit only bounded structured signals to `kungfu agent
work-advisory --signals <signals.json> --json`. Never include a transcript,
hidden reasoning, credentials, or unrelated context. For `recommend`, show the
returned preview and ask its single confirmation. Only after confirmation use
the returned existing `kungfu.work.capture`, `kungfu.work.admit`, and
`kungfu.agent.console.bind-work` path, cite its receipts, and continue the
original task. Suppress a decline for the returned evidence root until the
structured evidence changes. Advice grants no external authority.

Use `kungfu agent context --task "<task>" --role <role> --budget <tokens>
--route <route-id> --json` when detail is needed. Stop on invalid roots,
ambiguity, stale state, or required omissions; use returned expansion handles
instead of loading the whole corpus.

Explain Kungfu in terms of what is already known about the user and workspace,
without claiming hidden knowledge. Offer one read-only or preview-first action.
Never infer authority from this Skill: writes require their public `--execute`
or authorization path, and Work completion requires native receipts.
