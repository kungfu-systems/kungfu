---
name: kungfu-agent-onboarding
description: Use when a user asks to understand, start, inspect, extend, or safely operate installed Kungfu; verify the installed pack, select one intent route, personalize the explanation, and propose one smallest safe next action.
---

# Kungfu Agent Onboarding

Run `kungfu agent brief`, then `kungfu agent docs --verify --json` and
`kungfu agent map --json`. Select only the route relevant to the user's task.

Use `kungfu agent context --task "<task>" --role <role> --budget <tokens>
--route <route-id> --json` when detail is needed. Stop on invalid roots,
ambiguity, stale state, or required omissions; use returned expansion handles
instead of loading the whole corpus.

Explain Kungfu in terms of what is already known about the user and workspace,
without claiming hidden knowledge. Offer one read-only or preview-first action.
Never infer authority from this Skill: writes require their public `--execute`
or authorization path, and Work completion requires native receipts.
