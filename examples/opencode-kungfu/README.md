---
metadata_schema: kungfu.document-metadata/v1
document_status: draft
period: 2026-07-20
theme: kungfu-vendor-embedding
doc_type: guide
sources: [local-files, official-upstream, executable-probe]
confidence: high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-20
ai_provenance: OpenAI GPT-5 via Codex on 2026-07-20; hidden checkpoints and unobserved vendor internals are not claimed
---

# OpenCode + libkungfu reference plugin

This candidate package shows the narrow vendor-owned Agent Hub integration:
OpenCode keeps its TUI, models, provider accounts, permissions, tools, cloud
connection, and customer relationship. The plugin observes only public
lifecycle hooks and asks libkungfu to retain generic Episode evidence.

It does not fork OpenCode, replace its server or TUI, route model traffic,
inspect prompts or tool arguments, read provider credentials, or define a
second Episode implementation.

## Candidate install

The package is a source reference while Kungfu 4 remains pre-release. In an
exact candidate build, add the package name to the project configuration:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@kungfu-tech/opencode-kungfu"]
}
```

Optionally place the runtime outside the project:

```bash
export KUNGFU_OPENCODE_RUNTIME_DIR="$PWD/.kungfu/opencode"
opencode
```

The runtime directory must be exclusive to one OpenCode plugin process. On
startup, the plugin abort-recovers unsealed Episodes left by a terminated prior
process. A resumed OpenCode session begins a fresh Episode; recovery is not
silently represented as uninterrupted execution.

After the session closes, Episode export uses Core's transfer-only raw-JSON
edge so unsigned 64-bit identifiers remain exact across the Node boundary.
`exportEpisode(sessionId)` rejects an unsealed session and returns the native
bundle JSON text; consumers should persist or forward that text without
round-tripping it through a JavaScript `number`.

## Public hooks and retained fields

The adapter uses OpenCode's documented plugin function plus `event`,
`tool.execute.before`, and `tool.execute.after` hooks. It retains:

- an Episode open/heartbeat/end or abort lifecycle;
- fixed adapter-owned phase labels;
- native timestamps and aggregate heartbeat counts.

It deliberately drops prompt text, message content, tool arguments and output,
errors, model/provider identifiers, tokens, credentials, and client objects.
Hook outputs are not modified, so OpenCode remains the permissions and
execution authority.

## One native authority, three hosts

The shortest C, Node, and Python programs are in [`quickstart/`](quickstart/).
All three call the same libkungfu native storage authority:

- C negotiates `kungfu_get_api` v1 and calls ledger-action/maintenance tables;
- Node calls the typed functions projected by `@kungfu-tech/core`;
- Python calls `kungfu.storage.service`, which projects the same native service.

JSON is an edge compatibility payload for the C table, not a second canonical
semantic implementation. The KFD semantic evaluator remains the separate C++
reference adapter qualified by KFD Runtime 100.

## Honest limits

This is a first-party reference candidate, not evidence that OpenCode endorses
Kungfu or that another vendor has adopted it. Source-hook tests prove the
current public plugin shape without a provider account. Exact native, clean
install, crash/reopen, export/import, platform, and KFD verifier claims belong
to retained qualification reports for the tested artifact.
