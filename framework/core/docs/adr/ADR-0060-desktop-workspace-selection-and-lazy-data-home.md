---
status: draft
period: 2026-07-11
theme: kungfu-workspace-product
doc_type: decision
source_level: user-consensus-and-local-files
confidence: high
sensitivity: public
evidence_grade: B
review_state: unreviewed
last_reviewed: 2026-07-11
ai_provenance:
  model_family: GPT-5
  product: Codex
  generated_at: 2026-07-11
  visible_context: User workspace and Mission Control requirements, ADR-0035, ADR-0059, current GUI boot/runtime code, Saved Query Catalog implementation, Atlas dogfood behavior
  invisible_context_boundary: Did not inspect private Atlas bodies, credentials, provider payloads, or hidden model state
---

# ADR-0060: Desktop selects one workspace and initializes its `.kungfu` data home lazily

- Status: proposed
- Date: 2026-07-11
- Category: product architecture, workspace lifecycle, local data ownership
- Subsystem: Desktop shell, GUI main/renderer processes, config contract,
  workspace coordinator, Mission Control, Saved Query Catalog, CLI/agent surface
- Related: ADR-0035 defines workspace-local `.kungfu`; ADR-0057 defines the
  per-user supervisor and per-data-root coordinator; ADR-0059 defines Mission
  Control responsibility and authority.

## Context

The source and dev launchers can already derive a workspace `.kungfu` data home,
but the installed Desktop product cannot choose a project directory, remember
the last choice, or switch the selected fact world. A packaged launch therefore
falls back to Electron `userData/runtime`, while Work Dashboard immediately
renders Mission/Go lists and authoring forms against whichever runtime home was
inherited.

This breaks the intended product model. A user should be able to open a real
workspace such as `~/Code/atlas`, return to it on the next launch, and see the
Mission Control view backed by that workspace's `.kungfu`. Opening a directory
must remain read-only: it must not create `.kungfu`, journals, runtime files, or
Git ignore changes merely because the user inspected a project.

Saved Query Catalog makes the boundary load-bearing. Its QueryDefinition and
ViewSpec revisions are already journal-backed in the selected runtime data
root. They describe one fact world and therefore cannot be moved into a global
GUI preference file without losing their declaration, cut, and schema context.

## Decision

### 1. Workspace root and data home are distinct identities

Desktop selects a canonical **workspace root**. Its candidate Kungfu data home
is `<workspace-root>/.kungfu`. Symlinks are resolved for identity, while the
user-facing path may retain the path the user selected.

The product exports both identities before creating a renderer:

```text
KF_WORKSPACE_ROOT=<canonical workspace root>
KF_HOME=<workspace root>/.kungfu
KF_RUNTIME_DIR=<workspace root>/.kungfu/runtime
```

`KF_WORKSPACE_ROOT` is a product/session selector. `KF_HOME` remains the data
home selector. Callers must not pass a project root to `-H` and hope every layer
appends `.kungfu` independently.

### 2. Opening is read-only; initialization is write-intent-bound

Selecting or reopening a workspace performs only path validation, capability
discovery, and inspection of whether `.kungfu` already exists. It does not
create the data home.

When `.kungfu` is absent, Desktop enters `selected-uninitialized` state. It
must not call runtime joins, generate skill/runtime files, ensure a coordinator,
or construct a storage handle against the candidate path. The first operation
that would change the workspace fact world passes through one
`ensureWorkspaceDataHome(reason)` gate. Examples include:

- create or clarify a Mission;
- create a Go, claim completion, or record a decision;
- import Atlas or materialize a Mission/Episode/fact bundle;
- save a QueryDefinition/ViewSpec revision;
- record an Episode, fact material, source, or assessment.

Read-only Mission/Go inspection, workspace probing, config inspection, bundle
validation, and query planning do not initialize the workspace.

The ensure gate creates the minimum `.kungfu` layout, returns a receipt naming
the triggering intent, and then starts or attaches to the data-root
coordinator. Git ignore integration is an explicit follow-up action, not a
silent side effect of opening or initialization.

### 3. One Desktop process owns one selected workspace

Version 1 binds one Desktop process to one workspace candidate before runtime
handles are created. If the data home already exists, runtime boot is eager. If
it does not, runtime boot is deferred until the ensure gate succeeds; the
process already carries the candidate environment, so initialization does not
need to reinterpret the path.

Switching to another workspace disposes the current workspace lease and uses a
controlled application relaunch in the first delivery. This preserves the
in-process native capability boundary and prevents live handles, subprocess
environment, terminal hosts, and coordinator leases from spanning two fact
worlds. A later multi-workspace process model requires a separate ADR.

### 4. The last workspace is global product state, not a workspace fact

Desktop persists a versioned registry at:

```text
<KF_CONFIG_HOME>/gui/workspaces.json
```

The registry contains the last selected canonical root, bounded recent roots,
display paths, and non-authoritative availability metadata. It contains no
Mission bodies, Go state, facts, proofs, or imported Atlas payloads. A missing
or inaccessible last workspace degrades to the workspace chooser; it never
falls through to a different fact world silently.

Dynamic recent paths do not belong in the declarative `config.json` preference
override. They are user-level GUI session state under the same config home.

### 5. Local state has three standard homes

| Home | Owns | Must not own |
| --- | --- | --- |
| `<workspace>/.kungfu` | declarations, admitted facts, Episodes, payloads, source registry, Mission/Go/claim/decision facts, assessments, TrustReports, saved queries, observer metadata, rebuildable workspace projections and coordinator state | global recent workspaces, installed-product preferences |
| `~/.kungfu-config` (or `KF_CONFIG_HOME`) | user preferences, global trust/extension/skill policy, installed kfx/skill metadata, recent/last workspace registry, per-user supervisor routing state | workspace Mission/Go facts, saved query revisions, proof or imported Atlas bodies |
| platform machine fallback selected by `KF_HOME` | no-workspace runtime support, caches, service state, explicitly machine-scoped facts | an implicit merged Mission world for all projects |

`~/.kungfu` has no implicit default role. It is not a config compatibility path
and Desktop does not silently merge it with an opened workspace. A future
explicit **Personal Workspace** may select `~/.kungfu` as its data root, but it
must be created and opened deliberately like any other workspace.

Global installation and workspace participation remain distinct. The config
home may contain an installed kfx/skill package and user default policy; the
workspace pins the exact version, enablement/grant, declaration, and receipt
that participated in its fact world. A global update cannot reinterpret an
older workspace cut.

### 6. Existing workspace data loads without re-import

When the selected `.kungfu` exists, Desktop opens that data root and rebuilds
projections as needed. A completed Atlas import, native Mission, Go, assessment,
or Saved Query Catalog entry is immediately available from the same authority.
Opening does not re-import Atlas and does not mutate source authority.

If the selected root looks Atlas-compatible but no completed import exists,
Mission Home may offer **Import Atlas facts**. The action is explicit and is a
write intent, so it passes through lazy initialization. Import freshness and
source coordinates remain visible after completion.

### 7. GUI and agents use the same workspace contract

The installed CLI/API must expose machine-readable workspace selection and
inspection, including at least:

```text
kungfu workspace inspect <path> --json
kungfu workspace list --json
kungfu workspace current --json
kungfu workspace select <path> --json
```

Intent-level write commands accept an explicit workspace root or use ordinary
workspace discovery. Selecting a GUI workspace does not force every independent
agent command to use that global choice. Receipts disclose workspace root, data
home, whether initialization occurred, and the resulting fact/episode identity.

## Consequences

- The installed product can dogfood real repositories without a special dev
  launcher or manual environment variables.
- Reopening Desktop returns to the last workspace and the same Mission Control
  fact world.
- Read-only inspection cannot dirty a repository.
- Global GUI convenience state is separated from workspace authority.
- Saved Query Catalog remains correctly workspace-scoped; transfer uses its
  JSON artifact or a larger Mission/Episode bundle, not implicit global reuse.
- The first implementation must split current eager runtime boot into selected,
  selected-uninitialized, ready, unavailable, and degraded states.
- Controlled relaunch on workspace switch is a visible implementation cost but
  avoids cross-root native handle leakage in the first delivery.

## Rejected alternatives

- **Use Electron `userData/runtime` for every Mission.** Rejected because it
  silently merges unrelated projects and makes workspace transfer unclear.
- **Create `.kungfu` whenever a directory is opened.** Rejected because reading
  a project must not change it.
- **Store recent workspaces in `.kungfu`.** Rejected because the chooser must
  work before any workspace is opened and recent paths are not workspace facts.
- **Store Saved Query Catalog globally.** Rejected because a saved definition
  and view are bound to one declared fact world even when their JSON shape is
  portable.
- **Hot-swap runtime roots inside existing handles.** Rejected for version 1;
  native handles, coordinator leases, subprocess environment, and terminal
  hosts would otherwise risk crossing authority boundaries.
- **Restore `~/.kungfu` as an ambiguous global default.** Rejected because it
  collapses config, personal facts, machine state, and project facts again.

## Acceptance gates

- Opening a Git workspace with no `.kungfu` leaves the filesystem unchanged.
- The first Mission/Go/import/saved-query write creates exactly that
  workspace's data home and returns an initialization receipt.
- Restarting Desktop reopens the last valid workspace and loads existing facts.
- Switching workspace cannot expose the prior workspace's Mission, query, or
  runtime handles.
- Removing `~/.kungfu-config/gui/workspaces.json` forgets recents but does not
  delete or change any workspace fact.
- Deleting rebuildable projections does not delete Missions, assessments, or
  saved-query revisions.
- GUI and CLI report the same canonical workspace root and data home.

## Residual risk

- Nested repositories and symlinked paths need one canonical identity policy.
- A write-intent gate that misses an eager runtime side effect would violate the
  read-only open promise; product qualification needs filesystem before/after
  assertions.
- Controlled relaunch needs clear unsaved-dialog handling and lease release.
- Recent workspace paths can be sensitive metadata; the registry remains local,
  bounded, and outside portable Mission bundles.
