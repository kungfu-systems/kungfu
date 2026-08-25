# Work Control

Work Control is Kungfu's native responsibility layer. It keeps continuing
intent in an **Initiative**, gives bounded work to an **Assignment**, and shows
work across independently owned workspaces through a read-only **Portfolio**.

The active Profile identity is `kungfu.work-control` version `4.0.0`. Its
public actions, views, CLI, GUI, TUI, and Agent catalog use the same native
vocabulary.

## Authority model

- An Initiative owns a continuing intended change.
- An Assignment owns bounded responsibility, exact relations, an execution
  lease, evidence, review, and continuation state.
- A WorkRef identifies one object at one owning workspace and immutable cut.
- Portfolio composes verified workspace observations. It does not write work,
  invent containment, claim an atomic global cut, or decide completion.
- Project Cut remains the highest ordinary settlement boundary.

An Assignment can claim completion only with evidence. Independent review and
a continuation decision remain separate facts. Portfolio reports completion
only when the accepted decision and applicable Project Cut settlement are both
present.

Workspaces that contain pre-cutover `atlas-adapter` observations on the v1
Initiative or Assignment surfaces retain those immutable facts as history. The
current Profile may read them and append only through `kungfu-user` or
`kungfu-agent`; this narrow compatibility state neither restores the removed
adapter nor claims that an authority migration occurred. Any other retired or
unknown source authority remains a fail-closed migration requirement.

Portfolio keeps three state coordinates separate: the source record's
`source_status`, the native Assignment `orchestration_phase`, and the derived
`portfolio_state`. The default active-and-attention view treats compatibility
statuses `complete`, `completed`, `merged`, `archived`, and `closed` as
terminal; `--include-settled` retains their exact canonical rows. A
`stage-ready` Assignment is therefore visible as unfinished until review,
continuation decision, and Project Cut settlement actually complete it.

## Domain-neutral Work semantics

An executing Assignment may opt into a generic protocol for input freshness,
managed execution, and external effects. The adopter keeps its domain payload;
Kungfu stores only stable identities, enums, and SHA-256 content roots.

The ordered records are:

1. `work-input-snapshot` binds the current opaque input root to the exact
   Assignment Attempt and lease. A successor snapshot makes every earlier run
   and effect authorization stale.
2. `work-managed-run` binds one role, result state, result root, and evidence
   set to that exact snapshot and Attempt.
3. `work-effect-authorization` binds one effect identity, generic kind, and
   opaque scope root after a successful run.
4. `work-effect-attempt` is appended before transport. Once it exists, blind
   retry is forbidden.
5. `work-effect-outcome` records transport acceptance separately from the
   business outcome. An unknown transport result or an accepted transport with
   an unrecorded business result yields `reconcile-effect-outcome`, never a
   repeat instruction.

All writes pass through `kungfu.assignment-runtime/v1` with exact revision,
generation, Attempt, and active lease fencing. The folded
`work_semantics.next_actions` projection survives process restart and rebuilds
from the native append-only facts. When protocol records exist, completion is
refused until the latest effect attempts are settled and the completion claim
binds the current snapshot, run, and outcome roots.

The installed CLI accepts JSON containing only those public fields:

```text
kungfu work record-input INPUT.json --workspace <path> --authorized-by <actor>
kungfu work record-run INPUT.json --workspace <path> --authorized-by <actor>
kungfu work authorize-effect INPUT.json --workspace <path> --authorized-by <actor>
kungfu work record-effect-attempt INPUT.json --workspace <path> --authorized-by <actor>
kungfu work record-effect-outcome INPUT.json --workspace <path> --authorized-by <actor>
kungfu work status --workspace <path> --initiative-id <id> --assignment-id <id>
```

The protocol deliberately has no email, contact, HTTP, payment, or other
adopter-specific field. Private values remain behind adopter-owned content
roots and transport adapters.

Repeated Initiative subjects are rendered as one deterministic presentation
group. An authority-distinct group lists every canonical root and workspace
authority root; it is a readability projection only and never asserts replica
equivalence or discards an exact WorkRef.

Disposable probe processes that intentionally share the machine Catalog must
set `KF_WORKSPACE_CATALOG_LIFECYCLE=test-only` before their first workspace
write. The initial observation is then retained with the `test-only` lifecycle
and excluded from the default Portfolio. Existing active entries are changed
only through the dry-run-bound `workspace catalog-maintain` transition.

## Assignment Family typed envelope

`kungfu.work-control.initiative-family-state/v1` remains the immutable Wave 0
coordination projection. Its schemas, roots, validation, and CLI commands are
unchanged.

Version 2 is an additive typed envelope around that exact v1 projection. It
does not create another Work Control or settlement authority:

- the Initiative binds caller-supplied Pursuit, Atlas, and acceptance-policy
  references while remaining an inert parent;
- every child binds exact Assignment-state, work-definition, Pursuit, Atlas,
  and active execution-Warrant references;
- every merged child binds independent Completion Claim, Assessment, Decision,
  Admission receipt, Episode, Project Cut, and delivery-evidence references;
  and
- publication is separately `published`, `pending`, or `failed`. Pending and
  failed publication must expose the lag start, and a failure must carry a
  visible typed reference. A projection merge is never reported as completion.

Every typed reference names its semantic kind, stable identity, exact SHA-256
root, owning fact world, exact cut root, payload schema, and observed status.
The envelope verifies those coordinates but does not copy, mutate, or
reinterpret the referenced authority.

The upgrade is deliberately explicit:

```text
immutable v1 state
  + caller-supplied typed binding manifest for that exact v1 root
  -> v2 successor state
  -> exact v1 compatibility projection
```

Kungfu never guesses missing Pursuit, Atlas, Warrant, Claim, Assessment,
Decision, Admission, Episode, Project Cut, or delivery identities. A v2 reader
reports a valid v1 input as `under-typed-v1`; only an explicit upgrade produces
a fully typed state. Every v2 transition supplies both an exact v1 transition
and a complete binding manifest for the successor v1 root.

```text
kungfu work family-contract-v2
kungfu work family-upgrade-v2 STATE_V1 BINDINGS_V2 --out STATE_V2
kungfu work family-transition-v2 STATE_V2 TRANSITION_V2 --out SUCCESSOR_V2
kungfu work family-verify-v2 STATE_V1_OR_V2
```

## Atlas boundary

Admission requires either an exact Initiative WorkRef or a content-addressed
Initiative admission envelope carrying the parent identity, title, intent,
source authority, and immutable source version root. Missing, mutable, or
mismatched parents fail visibly.

## Product surfaces

```text
kungfu work capture <request.json>
kungfu profile work-control --help
kungfu work status --workspace <path> --initiative-id <initiative-id> --assignment-id <assignment-id>
kungfu work record-input --help
kungfu work authorize-effect --help
kungfu work gate --help
```

The Work Dashboard opens Portfolio as a live federated view. The TUI renders
the same Initiative and Assignment model. Native machine receipts use Work
Control schemas; explicit Atlas or compatibility inspection may retain source
terminology and sealed source bytes.

The normative decision is
[KF-ADR-019f9771-4c20-7e2c-8e7c-3f3cb3f1b9bd](../adr/KF-ADR-019f9771-4c20-7e2c-8e7c-3f3cb3f1b9bd.md).

## Post-merge delivery evidence

`kungfu.delivery-evidence.envelope/v1` is the adapter-edge contract for
admitting one protected GitHub delivery into the owning workspace. The
envelope binds the repository identity, pull-request number and exact head,
merge commit, workflow run and attempt, Buildchain receipt, artifact and schema
roots, merge-queue attempt root, and merge/run/observation timestamps. The
caller supplies the same coordinates under
`kungfu.delivery-evidence.expectation/v1`; their canonical root is the
idempotency key.

For Merge Queue delivery, the accepted chronology is validation run completion,
then the protected-branch merge, then observation. GitHub qualifies the
synthetic merge-group commit before advancing it onto the protected branch;
the adapter measures admission lag and freshness from that protected merge.

[`delivery_evidence.py`](../../framework/core/src/python/kungfu/delivery_evidence.py)
strictly rejects missing, malformed, stale, cross-repository, PR-head, merge,
run, receipt, artifact, schema, and queue mismatches. Missing evidence is a
retryable failure; malformed, stale, and contradictory evidence is terminal.
The native Fact state exposes retry count, first-seen and latest-attempt times,
admission lag, latest sanitized error root, the admitted Episode root, and
whether downstream Git settlement is still unpublished.

A successful retry converges on one Fact subject and one delivery Episode.
Duplicate delivery does not append another Fact observation, Episode, or
completion effect. The adapter accepts only the versioned envelope fields:
raw GitHub responses, logs, credentials, signed URLs, artifact bodies, and
private payloads are rejected as unknown input and never persisted.

GitHub executes and transports delivery evidence, and Buildchain produces its
receipt and artifact roots. Neither becomes work authority. Kungfu alone admits
the native Fact and Episode; Work Control separately decides completion. Git
settlement is a downstream projection and must consume the Episode root plus
the `unpublishedDownstream` state without rewriting this runtime authority.
