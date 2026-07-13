---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ADR-0035
decision_status: accepted
implementation_status: unknown
review_state: legacy-unreviewed
sensitivity: public
---

# ADR-0035: Workspace-local `.kungfu` is the default fact ledger home

- Status: accepted
- Date: 2026-07-09
- Category: (architecture) local data ownership, configuration homes, and
  workspace discovery
- Subsystem: runtime storage service, Episode store, manifest journal, config
  contract, product launchers, CLI, GUI, and agent workflows.
- Related: ADR-0018 defines the runtime storage service. ADR-0033 defines
  Episode as the first-class causal segment object. ADR-0034 defines the
  yijinjing-backed Episode manifest journal. [`docs/config.md`](../config.md)
  documents the user-facing home layout.

## Context

Kungfu originally treated `KF_HOME` as the runtime data home. If users did not
override it, the product effectively had one machine-level data home. That is
simple for a single installed application, but it is not the best default for
agent work.

Agents usually act inside a workspace: a Git repository, a worktree, a project
directory, or another local task root. The files, Markdown memory, source
history, and review artifacts already live there. With Episodes as first-class
objects, Kungfu data becomes closer to Git data than to a generic application
cache: it records the causal action history of that workspace.

The useful analogy is:

```text
workspace files  = current file-world state
.git             = file history and branch metadata
.kungfu          = workspace action facts, Episodes, manifest journal, payloads
```

Kungfu should not require Git, but when a Git root exists it can provide a
natural workspace boundary and useful metadata for Episode provenance.

At the same time, user-level product configuration should not live in the same
directory as runtime data. The old default `~/.kungfu` for config is ambiguous:
it sounds like the global data home and conflicts with the new `.kungfu/`
workspace convention. Kungfu is still pre-release, so this is the right time to
hard-cut the config path instead of carrying migration compatibility.

## Decision

Kungfu separates local state into three roles:

| Role | Default / selector | Contents |
| --- | --- | --- |
| Workspace data home | nearest `.kungfu/`, or `<git-root>/.kungfu/` when a Git root exists | Episode store, Episode manifest journal, payload bodies, projections, source registry, workspace-local runtime facts |
| User config home | `KF_CONFIG_HOME`, default `~/.kungfu-config` | GUI settings, global trust policy, installed kfx/skills, user preferences, config overrides |
| Machine data fallback | explicit `KF_HOME`, or platform product fallback when no workspace data home applies | machine-level runtime state, global catalog/cache/service state, non-workspace facts |

The default data-root resolution order is:

1. an explicit runtime/home option supplied by the caller;
2. explicit `KF_HOME`;
3. nearest ancestor `.kungfu/`;
4. if inside a Git worktree and no ancestor `.kungfu/` exists, `<git-root>/.kungfu/`;
5. machine-level `KF_HOME` fallback.

Git is an integration point, not a hard dependency. In a non-Git directory,
Kungfu can still discover an ancestor `.kungfu/` or use the machine fallback.
When Git exists, Kungfu may record repository root, worktree identity, commit
refs, and branch metadata as Episode/source metadata.

`~/.kungfu` is no longer a default config directory. The new default config home
is `~/.kungfu-config`. Because Kungfu has not shipped as a stable product, this
is a hard cut:

- do not silently read `~/.kungfu/config.json` as a compatibility default;
- do not auto-migrate from `~/.kungfu` to `~/.kungfu-config`;
- an explicit `KF_CONFIG_HOME=~/.kungfu` is still honored because explicit
  caller input wins, but it is not the product default.

Workspace `.kungfu/` data should normally be ignored by Git. Commands that
initialize workspace storage may offer or perform `.gitignore` integration, but
read-only commands must not modify `.gitignore` as a side effect. Portable
exports or selected evidence bundles can be committed deliberately by the user;
raw workspace `.kungfu/` storage is not committed by default.

## Consequences

- Episode facts sit near the workspace whose actions they describe. This keeps
  project A and project B from silently sharing one machine-wide action ledger.
- Multiple Git worktrees get independent `.kungfu/` homes by default, reducing
  collisions between dev runs, GUI state, journals, and projections.
- `KF_HOME` remains useful. It is the explicit/machine-level runtime data
  fallback, not the only world.
- `KF_CONFIG_HOME` has a clearer default and no longer competes with data
  storage terminology.
- Git-aware behavior becomes additive: better default placement, `.gitignore`
  support, and provenance metadata. Kungfu still works in non-Git directories.
- Implementation must update config contracts, launchers, `kungfu config path`,
  GUI/TUI dev launch, and docs together so agents can discover the same layout
  from C++, Python, Node, and CLI surfaces.

## First delivery

This ADR records the architecture decision and updates documentation.

Implementation work remains separate:

- update `config-contract` defaults from `~/.kungfu` to `~/.kungfu-config`;
- add workspace data-home discovery;
- teach `kungfu config path --json` and agent context output to report
  `workspaceDataHome`, `configHome`, and `machineDataHome`;
- add `.kungfu/` ignore support to explicit init/setup flows;
- make product dev launchers prefer workspace-local data homes unless an
  explicit instance home or `KF_HOME` is supplied.

## Explicitly out of scope

- Committing raw `.kungfu/` storage to Git by default.
- Requiring Git for Kungfu data.
- Removing `KF_HOME`.
- Automatically migrating old local dogfood directories.
- Solving remote sync policy or Episode conflict resolution.

## Alternatives considered

- **Keep one machine-wide `KF_HOME` as the default data world.** Rejected. It
  makes independent projects and worktrees collide and hides the natural
  boundary of agent action facts.
- **Require Git and always place `.kungfu/` next to `.git/`.** Rejected. Git is
  a useful integration point, but Kungfu should work for non-Git workspaces and
  local runtime data.
- **Keep `~/.kungfu` as config home for compatibility.** Rejected. Kungfu is
  pre-release, so a hard cut avoids permanent ambiguity between user config,
  machine data, and workspace `.kungfu/`.
- **Rename `KF_HOME` immediately.** Rejected. `KF_HOME` remains a useful and
  already-known explicit runtime data override. The architectural problem is the
  default scope, not the existence of the variable.

## Residual risk

- Auto-creating `.kungfu/` on read-only commands would surprise users and dirty
  workspaces. Creation must be tied to write/init operations.
- Tooling must be careful in nested repositories and submodules. The nearest
  existing `.kungfu/` should win before creating a new Git-root `.kungfu/`.
- If docs move faster than implementation, `kungfu config show --json` may
  temporarily report the old defaults. The implementation slice should follow
  this ADR quickly.
