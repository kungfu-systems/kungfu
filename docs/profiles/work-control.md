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

## Atlas boundary

Atlas is an optional source and compatibility adapter, not the native work
identity authority. Its source fields may be retained inside an Assignment's
auditable work definition, but an Atlas parent identifier is not automatically
an Initiative identifier. Admission requires either an exact Initiative
WorkRef or a content-addressed Initiative admission envelope carrying the
parent card's identity, title, intent, source authority, and immutable source
version root. Missing, mutable, or mismatched parents fail visibly.

Historical `kungfu.mission-control` worlds and receipts remain exact,
read-only compatibility evidence. They are documented separately so their
terminology does not define the current product.

## Product surfaces

```text
kungfu work --help
kungfu work --help
kungfu work status --help
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
