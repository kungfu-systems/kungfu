# Project Cut Product Loop Architecture

This design turns the accepted product decision in
[ADR-0127](../adr/ADR-0127-project-cut-centered-product-loop.md) into an initial
implementation boundary. It extends the current Project Cut settlement and
Agent Work implementations without changing their frozen identities.

## Layer map

```text
Settlement plane
  Project Cut: project-level accepted commitment and continuation coordinate

Work plane: Agent Work Domain Profile
  Initiative: continuing intended change
  Assignment: bounded accepted responsibility

Responsibility plane: Action Geometry
  Pursuit: direction
  Atlas: perspective and accepted cut
  Warrant: bounded authority

Ontology and runtime
  Fact: admitted state
  Episode: realized causal occurrence
```

Claim, Assessment, Decision, and supporting evidence form a trust path across
the planes. They answer whether an Assignment's consequence may enter a
successor Project Cut. They are not another peer storage plane.

The architecture preserves two invariants:

1. a higher plane may bind and project lower authority but cannot replace it;
2. one interface may present several responsibilities together, but each must
   remain independently inspectable and counterfactually distinguishable.

## Project Cut read model

The read model should answer four questions without mutation:

| View | Question |
| --- | --- |
| Current Project Cut | What project state is currently accepted, at which exact roots? |
| Active Work | Which Initiatives and Assignments may advance it? |
| Pending Settlement | Which candidate exists, what evidence supports it, and what blocks it? |
| Cut History | Which predecessor, successor, supersession, and publication relations are verified? |

The read result has an explicit health state:

- `absent`: no Project Cut has been settled for this project;
- `current`: the exact cut and its required authorities verify;
- `degraded`: a known authority, body, provider, or verification witness is
  unavailable or stale; and
- `conflicted`: candidate authorities or settlement relations disagree.

An absent state is not an error and must remain read-only. The response may
recommend an explicit bootstrap command but cannot run it implicitly.

## Settlement transaction

Settlement is a transaction protocol, not one overloaded status field:

```text
preview
  -> prepared
  -> verified
  -> settled

prepared or verified
  -> rejected | superseded | abandoned
```

- **preview** computes a deterministic plan and candidate roots without writes;
- **prepared** records explicitly requested immutable candidate material;
- **verified** proves the candidate against the pinned source, Atlas, Episode,
  Assignment, Warrant, Claim, Assessment, and policy inputs;
- **settled** advances the authoritative Project Cut ref and emits a typed
  settlement receipt; and
- terminal non-success states retain the candidate coordinates and reason
  without pretending that the current cut advanced.

Preparation and settlement must not share an implicit commit point. If a
process exits after preparation, the current cut remains unchanged and
recovery can verify, settle, supersede, or abandon the candidate explicitly.

## Proposed command surface

The first public surface is intentionally narrow:

```sh
kungfu cut
kungfu cut show [--cut <root>] [--json]
kungfu cut diff [--from <root>] [--to <root|candidate>] [--json]
kungfu cut prepare [--assignment <id>] [--execute] [--json]
kungfu cut verify --candidate <root> [--json]
kungfu cut settle --candidate <root> --execute [--json]
kungfu cut history [--json]
kungfu cut export --cut <root> --output <path> [--thin|--complete]
```

Behavioral rules:

- `kungfu cut`, `show`, `diff`, `verify`, and `history` are read-only;
- `prepare` is dry-run unless `--execute` is present;
- `settle` always requires `--execute` and an exact candidate root;
- no command commits or pushes Git implicitly;
- human and JSON modes carry the same semantic status, problems, roots, and
  next valid actions; and
- every write returns a typed operation receipt and a postcondition that can be
  independently re-verified.

The current `./shifu project-cut` command remains the developer and protocol
implementation surface. The public command should compose it through stable
contracts, not fork its canonicalization or verification logic.

## Initiative and Assignment projection

The initial Agent Work projection should use:

```text
Initiative
  id, title, intended outcome, lifecycle, Pursuit roots, parent/related links

Assignment
  id, Initiative links, accepted responsibility, Atlas root, Warrant root,
  success conditions, lifecycle, Claim/Assessment/Decision roots,
  Episode roots, candidate Project Cut root
```

These are target product fields, not a new Fact store. Stable identities,
immutable versions, relations, refs, cuts, and receipts remain Fact Kernel
services. Execution remains Episode-backed. Authority remains Warrant-backed.

An Assignment may contribute to several Initiatives, and an Initiative may
contain several Assignments. Containment, dependency, delegation, and
continuation are separate typed relations. None implies another.

Mission/Go compatibility adapters may initially supply these projections. They
must expose the original root and mapping version, and they may not relabel an
existing Mission or Go root as a native Initiative or Assignment root.

## Agent loop

The target first-use loop is:

```text
kungfu cut
  -> agent accepts or creates one bounded Assignment
  -> action binding pins Initiative/Pursuit, Atlas, Warrant, and current cut
  -> agent executes while Kungfu records the Episode
  -> agent submits a completion Claim
  -> independent Assessment produces a Decision
  -> kungfu cut prepare computes the candidate successor
  -> kungfu cut verify proves the candidate
  -> explicit settlement advances the current Project Cut
```

A fresh agent context should be able to continue from the settled cut without
reconstructing project purpose, accepted perspective, authority, or prior
occurrence from chat transcripts.

## GUI and TUI projection

The primary surface should present four unframed work areas rather than one UI
component per primitive:

- Current Project Cut;
- Active Work;
- Pending Settlement; and
- Cut History.

Expanding Active Work reveals Initiative and Assignment. Expanding evidence or
a blocking problem reveals the exact Atlas, Warrant, Episode, Claim,
Assessment, Decision, roots, and residual risks. The user can stay at the
project level until a consequence requires deeper inspection.

The GUI and TUI call the same public plans and actions as the CLI and agent
surface. A button may shorten an interaction but cannot bypass explicit
settlement or generate a stronger receipt.

## Implementation slices

1. **Read-only cut aggregate:** expose current, active-work, candidate, history,
   and problem projections without creating `.kungfu`.
2. **Work projection:** introduce versioned Initiative/Assignment schemas and
   compatibility mappings from current Mission/Go state.
3. **Transactional settlement:** compose prepare, verify, and explicit settle
   over existing Project Cut, Agent Work, and trust contracts.
4. **Agent continuation:** make the settled cut the exact bootstrap and
   continuation coordinate for a fresh agent context.
5. **Human surfaces:** project the same read model and actions into TUI and GUI.
6. **Release closure:** bind the complete product qualification to source,
   platform artifacts, receipts, and the release passport.

Each slice must preserve the current protocol readers and pass differential
fixtures before any authority cutover.

## Non-goals

This design does not:

- change `project.cut/v1` canonical bytes or roots;
- make Project Cut a database, ledger, source tree, Atlas, or Episode;
- require every simple task to expose every lower primitive;
- claim that Initiative/Assignment storage or `kungfu cut` already exists;
- infer successful work from process exit, a Git diff, a sealed Episode, or a
  self-authored Claim; or
- publish, commit, push, or modify a project during read-only discovery.
