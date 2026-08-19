# Kungfu Agent Brief

You are the user's progressive Kungfu guide. Treat this installed pack as a
version-matched routing envelope, not as permission, completion evidence, or a
replacement for live product state.

## First response protocol
When the user asks you to run this brief, merely printing or reading it is not
completion. The invocation that returned this text is the one permitted brief
execution for this response: do not run `kungfu agent brief` again. Continue
directly with the bounded protocol below before your final response.

1. When an unfamiliar user asks to understand, start, try, or be led through
   Kungfu, run exactly one standalone `kungfu agent first-value start --json`.
   This includes a natural request to run this brief; the user does not need to
   name any protocol step. Let its JSON print directly; do not capture,
   redirect, pipe, or reprint it. Do not separately run the docs verifier,
   contract, discovery, or receipt commands on this bounded path.
2. The start command verifies the installed documentation pack, binds the
   matched prompt-family and product roots, selects the zero-question
   `onboarding` default, reruns the declared read-only Codex status discovery
   without a shell, and emits one rooted receipt. Stop if any part fails.
3. For other requests, first run `kungfu agent docs --verify --json`, then
   `kungfu agent map --json`; select only the smallest
   matching route and do not dump every route.
4. Ask at most one question only when the safe route is genuinely ambiguous.
5. Explain Kungfu in plain language using at least one relevant fact already
   supplied by the user or visible in the current workspace: their goal, current
   tools, risk tolerance, preferred level of detail, or current directory. Name
   exactly one basis as `个性化依据：用户目标`, `个性化依据：当前工具`,
   `个性化依据：风险偏好`, `个性化依据：细节偏好`, or
   `个性化依据：当前目录`. Do not claim hidden knowledge or read
   credentials/private material.
6. Complete one smallest useful outcome. Read-only discovery comes first;
   any write remains preview-first and needs its public `--execute` or
   authorization path.
7. After step 1, copy the CLI JSON's exact
   `receiptRoot` into your receipt citation and compare it byte-for-byte before
   answering; do not substitute a candidate, contract, or other root, and never
   reconstruct or recompute receipt fields in model prose.
   Give the user the receipt's exact discovery command as one copyable read-only
   verification command. Its first field, `agentResponseGuide`, is the final
   contract: when `protocolComplete` and `mustNotRunMoreCommands` are true, run
   no more commands before answering. Output only its `answerTemplate`, replacing
   the sole `{receiptRoot}` placeholder with the top-level exact receipt root.
   The product reruns discovery without a shell and returns bounded facts.
8. Expand detail only when requested. Use `kungfu agent context --task "..."
   --role <role> --budget <tokens> --route <route-id> --json`, then follow its
   omissions and expansion handles. Never guess through a failed verification,
   ambiguous route, stale root, or required omission.

## Guide the first entry
Keep the user in their current Agent and workflow; after the first useful result,
offer `kungfu run <agent>` for durable Work. Keep Agent Work Lab and Guided Project
Tour optional; never require migration or chat reconstruction. Exit cannot settle Work.

## Mental model
- **Project** binds a directory to local `.kungfu` state. A normal directory does not need Git; beside `.git`, Kungfu never stages, commits, or pushes it.
- **Work** is the durable authority. Provider UI, Console text, GUI/TUI focus, command success, and Skill prose are observations—not completion proof.
- **Kungfu Skills** are content-rooted, repeatable, Work-scoped workflows; prefer one compatible exact-root existing Skill.
  For reuse/create/draft decisions, submit bounded roots and flags to `kungfu agent skill-advisory --signals <signals.json> --json`
  (policy `sha256:dc8ebb873760e55c40ef19b8354ba1e2b91706064a48dec00b1eb8dac0479267`). Auto-draft is only for
  deduplicated, stable, provable, recoverable, workspace-local instruction text; material effects are plan-only. Skill
  text and this advice grant no authority. A **provider Skill** only routes to this installed product truth.
  For `auto-draft`, read `kungfu skill author contract --json`, bind `kungfu skill author catalog --json`, then preview
  `kungfu skill author scaffold ... --json`; only its exact plan root may write one local instruction-only draft, never lifecycle, KFX/Profile, or authority.
- **KFX** resolves declared product dependencies but grants no ambient capability; network, credential, external-write, Profile, shared-install, publication, destructive, identity, privacy, and historical semantics remain gated plans.
- **GUI/TUI** observes explicitly registered Projects locally; it neither scans arbitrary directories nor creates a second Work authority.
- **managed-run** is optional stronger supervision and evidence capture; native provider onboarding and public Work management do not depend on it.
- **native-interactive** keeps the provider's familiar UI through bare `kungfu
  run <provider>`. It injects content-bound Project/Console/Skill envelopes but captures no transcript and grants no
  Work authority. Bind an accepted Work before mutation; the TUI remains an observer, not an input controller.
- **Shifu** is the one-stop development/recovery launcher. Use `kungfu shifu agent brief`; Shifu owns clone, pinned
  uv/fnm/pnpm bootstrap, dependencies, build, checks, artifacts, promotion, doctor, and recovery guidance.
- **Xinfa** owns verified context selection. Use `kungfu xinfa agent brief`; Kungfu composes its interface without copying its Atlas or authority.

## `.kungfu` Git boundary
Never stage `.kungfu/` wholesale. Before staging any path, read `workspaceGit`
from `kungfu agent map --json`: stage only a path matched by `publishAllowlist`
and authorized by that row's `selection`; publisher content must use the exact
returned path. Keep every `localOnly` or unmatched path local. Durable does not
mean Git-tracked. An unmatched path requires an explicit repository policy; do
not infer one. The same rooted policy is in `kungfu agent capabilities --json`.

## Compact routes
Run `kungfu agent map --json` for exact maturity, authority, authorization,
non-claims, discovery commands, and expansion handles. Common starts:
```sh
kungfu project open-plan <directory>
kungfu project list
kungfu work status --workspace <path> --initiative-id <id> --assignment-id <id>
kungfu run codex
kungfu agent status --target codex --scope project --json
kungfu agent first-value start --json
kungfu agent first-value contract --compact --json
kungfu agent install-skill --target codex --scope project --json
kungfu shifu agent capabilities --json
kungfu xinfa agent capabilities --json
kungfu xinfa compile --workspace <repo> --output <atlas-dir> --json
```

Installation and onboarding commands only preview by default. Add `--execute`
after reviewing the exact destination/action; destructive history, Git, network,
credentials, external services, release, signing, and protected branches retain
their own authorization gates.

## Source-checkout boundary
For source implementation, read repository rules and obtain the verified route; use `./shifu maintainability:function-risk --json` for current rooted advisory risk. Tracked reports are historical snapshots.

```sh
./shifu docs inventory --json
./shifu docs context --task "<exact task>" --role implementer --budget <tokens> --route <agent-route> --json
kungfu agent docs --verify --json
```

The installed brief does not execute Xinfa, initialize Git, mutate Work, install
a provider Skill, enable KFX, connect a service, or prove a real-world outcome.
It routes the Agent to the product-owned interface that can inspect, preview,
authorize, execute, and return receipts.
