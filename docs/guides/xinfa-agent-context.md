# Verified Context for Agents

Use Xinfa before implementation when an Agent must decide which Kungfu
documents, contracts, evidence, and implementation bindings govern a task.
Xinfa compiles one immutable Atlas and selects a bounded Task Chart from that
verified cut. It prevents a convenient README, stale summary, or guessed route
from silently becoming authority.

## Source checkout: compile the Task Chart

Start with the project-owned inventory. Its route declarations are the
machine-readable source for route IDs, audiences, capabilities, owners, and
selection paths:

```sh
./shifu docs inventory --json
```

Select an exact `audience: "agent"` route whose declared subjects,
capabilities, owners, role, and Mission track match the task. Then compile the
Task Chart through Shifu's thin Xinfa adapter:

```sh
./shifu docs context --task "<exact task>" --role implementer --budget <tokens> --route <agent-route> --json
```

The current bounded routes are:

| Work | Agent route | Measured complete budget |
| --- | --- | ---: |
| documentation control, human surfaces, or Xinfa integration | `kungfu-documentation-control-agent` | 66,560 |
| Core architecture or implementation | `kungfu-core-development-agent` | 16,384 |
| kfx or Profile development | `kungfu-kfx-development-agent` | 16,384 |
| product-use guides and operations | `kungfu-user-guide-agent` | 16,384 |

These values describe the current Kungfu surface policy, not universal Xinfa
defaults. Re-read the inventory when the policy changes. A smaller positive
budget is valid only when the returned omissions and expansion handles remain
acceptable for the task.

For a documentation change, bind KFD-1 impact to the same operation:

```sh
./shifu docs context --task "<exact task>" --role implementer --budget 66560 --route kungfu-documentation-control-agent --since <baseline-atlas> --json
```

Before final readiness, compile the paired Human view and Agent Task Chart from
the same authority:

```sh
./shifu docs final-ready --since <git-ref> --budget 66560 --json
```

Do not proceed when route resolution is ambiguous or degraded, Atlas
verification fails, authority is stale, or a required omission remains.
Resolve the structured task intent or use the returned expansion handle; never
fall back to the first route or to README-only context.

## Installed runtime: compile or verify an Atlas through Kungfu

The installed Kungfu runtime carries an Agent onboarding pack, a precompiled
documentation Atlas, and a private independently qualified Xinfa engine. The
only public executable is `kungfu`:

```sh
kungfu agent brief
kungfu agent docs --json
kungfu agent docs --verify --json
kungfu agent docs --catalog --json
kungfu agent docs --projection agent --json
kungfu xinfa compile --workspace <repo> --output <atlas-dir> --visibility public --json
kungfu xinfa verify --atlas <atlas-dir> --json
```

`kungfu agent docs --json` also returns the installed Agent pack root and lists
`xinfa-context.md`, the offline copy of this operating boundary. Product
documentation reads are limited to paths present in the verified packaged
Atlas. A task-specific chart requires a declared project submission and an
explicit coordinator; it does not require a second installed executable.

## Public Xinfa help and schemas through Kungfu

The Xinfa engine is self-describing behind the single Kungfu entrypoint. These
commands are the canonical help for automation; do not infer fields from prose:

```sh
kungfu xinfa contract --json
kungfu xinfa schema task-envelope
kungfu xinfa schema route-resolution
kungfu xinfa schema task-chart
kungfu xinfa diagnose --json
```

In this source tree, `./shifu docs context` compiles and verifies the Atlas,
selects the declared route, and invokes the Xinfa `context` engine operation.
For installed composition, the primitive flow is:

```sh
kungfu xinfa compile --workspace <repo> --output <atlas-dir> --visibility public --json
kungfu xinfa verify --atlas <atlas-dir> --json
kungfu xinfa route resolve --atlas <atlas-dir> --task <task-envelope.json> --json
kungfu xinfa context --atlas <atlas-dir> --route <route-id> --task "<exact task>" --role <role> --budget <tokens> --json
```

The route-resolution receipt and Task Chart must bind the same verified Atlas
root and current route authority. Preserve those roots across handoff and
review.

## Automation boundary

Atlas `go` can automatically invoke this flow because its coordinator creates
a structured task envelope, resolves one exact route, verifies the chart, and
binds the roots into Project Cut and completion evidence. That is coordinator
behavior, not a side effect of Markdown or Episode storage. A Go card, a
`.kungfu/episodes` record, `AGENTS.md`, or an installed Skill can instruct an
Agent to call Xinfa, but none of them alone executes the compiler.
In other words, storage or instructions alone do not execute Xinfa.

The Task Chart is verified context, not ambient permission or completion
proof. Continue to follow repository rules, inspect the selected sources and
implementation, run the declared gates, and obtain the required independent
review.
