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

Portfolio keeps three state coordinates separate: the source record's
`source_status`, the native Assignment `orchestration_phase`, and the derived
`portfolio_state`. The default active-and-attention view treats source statuses
`complete`, `completed`, `merged`, `archived`, and `closed` as
terminal; `--include-settled` retains their exact canonical rows. A
`stage-ready` Assignment is therefore visible as unfinished until review,
continuation decision, and Project Cut settlement actually complete it.

Repeated Initiative subjects are rendered as one deterministic presentation
group. An authority-distinct group lists every canonical root and workspace
authority root; it is a readability projection only and never asserts replica
equivalence or discards an exact WorkRef.

Disposable probe processes that intentionally share the machine Catalog must
set `KF_WORKSPACE_CATALOG_LIFECYCLE=test-only` before their first workspace
write. The initial observation is then retained with the `test-only` lifecycle
and excluded from the default Portfolio. Existing active entries are changed
only through the dry-run-bound `workspace catalog-maintain` transition.

## Assignment Family

`kungfu.work-control.initiative-family-state/v1` is the current native bounded
coordination projection. Its schema, roots, validation, transition, and CLI
commands form one self-contained contract. Kungfu does not expose an upgrade
reader or predecessor projection alongside it.

## Product surfaces

```text
kungfu work capture <request.json>
kungfu profile work-control --help
kungfu work status --workspace <path> --initiative-id <initiative-id> --assignment-id <assignment-id>
kungfu work gate --help
```

The Work Dashboard opens Portfolio as a live federated view. The TUI renders
the same Initiative and Assignment model. Native machine receipts use Work
Control schemas and native source coordinates.

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
