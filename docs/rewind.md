---
metadata_schema: kungfu.document-metadata/v1
document_status: active
doc_type: public-document
review_state: unreviewed
sensitivity: public
---

# Rewind an Episode

Rewind is the user-facing operation of reopening an **Episode** for causal
inspection, verification, proof, and recovery. It is one operation over
Kungfu's execution infrastructure, not the identity of the whole product and
not a synonym for recording an agent run.

```text
Rewind an Episode.
Replay its Facts.
Recover only to a proven frontier.
Never repeat external side effects implicitly.
```

This page explains that contract and the current pre-release agent-work capture
slice that exercises it.

## Rewind, Replay, Recovery, and re-execution

These operations have different authority:

| Operation | Meaning | Boundary |
| --- | --- | --- |
| **Replay** | reconstruct recorded Facts and derived state under declared runtime semantics | fidelity is limited to the capture boundary and retained evidence |
| **Rewind** | reopen an Episode at a reproducible Cut to inspect its causal chain, verify evidence, and understand what happened | defaults to forensic inspection; it does not create new Facts about the outside world |
| **Recovery** | validate retained authority, identify the last proven frontier, classify an uncertain tail, and rebuild Projections | restart alone is not proof of recovery |
| **re-execution** | perform actions again against a live or simulated environment | must be an explicit mode with declared side-effect, consent, and idempotency policy |

[ADR-0020](../framework/core/docs/adr/ADR-0020-agent-action-timeline-and-replay-boundary.md)
is the load-bearing boundary: Kungfu records the causal action chain and its
evidence, not a complete snapshot of the outside world. A model call, tool
invocation, payment, message, deployment, or device command is never repeated
merely because a reader opened Rewind.

For crash and power-loss semantics, use
[Strong Durability and Crash Recovery](durability-and-crash-recovery.md).

## What an Episode contributes

A run is an execution coordinate. An Episode is the stable semantic object that
binds the work to:

- typed Facts and their provenance;
- Artifacts and external references;
- causal frame relationships;
- its Manifest, lifecycle, and content root;
- Receipts and applicable Watermarks;
- declaration and schema roots needed to decode the record;
- Cuts, Proof, and known missing or unverifiable material.

Rewind should therefore start from Episode identity and retained authority.
Profile-specific coordinates such as an agent `run_id` may help locate an
Episode, but they do not replace it.

Inspect the current Episode surface with:

```sh
kungfu storage episode list --json
kungfu storage episode inspect --episode-id <episode-id> --json
kungfu storage fsck --scope episode --episode-id <episode-id> --verify-frames --json
```

SQLite rows and GUI models may make that inspection convenient. They remain
rebuildable Projections, not a second Episode authority.

## Current agent-work capture slice

The current pre-release `trace` adapter wraps a command, assigns a `run_id`,
records model/tool/action Facts, and creates one Episode whose source is
`rewind:<run-id>`. It also emits a self-describing trace bundle containing the
schema material needed to decode the captured action Facts.

```sh
kungfu trace -- python3 my_agent.py
```

The traced process needs no Kungfu SDK call. Python and Node instrumentation is
injected into the child process, while provider traffic is routed through the
local capture supervisor. This is a useful Agent Work profile adapter; it is
not the definition of an Episode and it does not capture every possible fact
about the outside world.

Capture is sensitive by nature. Request, response, tool input, and tool output
bodies may contain private data. Provider credentials remain in headers and
are not intentionally recorded, but users must still apply their own data,
retention, redaction, and provider-compliance policies. Default capture and
inspection are local; the model request still reaches the upstream provider the
original command selected.

## Forensic inspection of a captured Episode

The current capture adapter retains `run_id` commands for its profile-specific
view:

```sh
kungfu rewind show --run <run-id>
kungfu rewind verify --run <run-id>
```

`show` reconstructs the captured action tree. `verify` compares native decoding
with reflection decoding through the run's bound schema bundle. A passing
result proves that those decode paths agree for the retained trace Facts; it is
not a universal proof that every outside-world effect was captured or that the
underlying storage met an unqualified durability profile.

The desktop reference surface can render the same profile-specific run and
action details. Its panes are views over the retained Facts, not the authority
for them.

## Portable evidence

The trace adapter can package its run-specific journal and self-describing
bundle, then reopen and verify that package elsewhere:

```sh
kungfu rewind export --run <run-id> --out <run-id>.rewind.zip
kungfu rewind open <run-id>.rewind.zip
```

The domain-neutral Episode surface also supports a self-contained storage
bundle:

```sh
kungfu storage export --scope episode --episode-id <episode-id> \
  --format bundle-json --out <episode-id>.json --json
```

The two formats currently serve different surfaces. A `.rewind.zip` preserves
the agent-work trace adapter's profile bundle; an Episode storage bundle
preserves the domain-neutral Episode closure. Do not infer that one format has
all guarantees of the other without checking its manifest and qualification
evidence.

## Recovery is a separate decision

After a crash, Rewind can help inspect an interrupted Episode, but it must not
declare recovery from visual plausibility. Recovery must establish the selected
durability profile, last proven Watermark, uncertain or corrupt tail, required
repair or quarantine, rebuilt Projection frontier, and capabilities that remain
safe.

Use the read-only repair plan before any mutation:

```sh
kungfu storage repair --scope episode --episode-id <episode-id> \
  --plan --dry-run --json
```

Current strong power-loss recovery remains staged and explicitly unqualified;
see [Known Limits](known-limits.md). Rewind does not upgrade that maturity.

## Current maturity

The source tree contains executable fixtures for trace capture, Episode
attachment, causal rendering, independent decode verification, tamper
rejection, export/open, cross-runtime edges, managed runs, approvals, and cost
Facts. The fixtures live under `tests/fixtures/rewind-demo-*` and use `run.mjs`
drivers.

This is pre-release evidence, not a polished one-command install or a claim of
complete framework coverage. Current limits include partial framework
instrumentation, profile-specific `run_id` commands beside the Episode-native
storage surface, raw streaming capture in some paths, sensitive-body policy
remaining operator-owned, and re-execution deliberately not being a default
mode.

Go next to [The Episode](the-episode.md), [Event Model](event-model.md),
[Vocabulary](vocabulary.md), and [Known Limits](known-limits.md).
