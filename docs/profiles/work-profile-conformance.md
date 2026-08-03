# Work Profile Conformance

The Work Profile Conformance Gate is an optional, read-only qualification of a
Work-capable Profile. It decides whether one declared domain mapping preserves
Kungfu's existing Fact/Episode, Action Geometry, Work lifecycle, Cut, and
high-level Work API authority. It does not install or activate a Profile, create
an Assignment, settle Work, or introduce another registry or execution engine.

## Public Profile integration

A Profile qualification may contain a content reference named
`workConformance`. The existing `kungfu profile validate` and
`kungfu profile qualify` paths verify the referenced bytes and invoke the same
checker. Both responses expose `workConformance` with the same declaration
root, conformance root, verdict, constraints, diagnostics, residual risk, and
non-claims. A Profile without this optional reference retains its existing
behavior and reports no Work conformance result.

The source checker remains available for authoring and repository
qualification:

```sh
./shifu work-profile:conformance -- --declaration declaration.json --surface validate --json
./shifu check:work-profile-conformance
```

Every relevant platform and Profile surface must be declared. A surface can be
explicitly `not-relevant` and `unsupported`; omission is invalid. A requested
public surface must be required, supported, and present in the result's rooted
surface projection.

## Machine proofs and human declarations

The checker proves only retained, content-addressed properties:

- exact Action Geometry, domain Profile, five role schema, Work lifecycle,
  source, Buildchain, and high-level Work API coordinates;
- distinct Fact, Episode, Pursuit, Atlas, and Warrant responsibilities;
- no domain Core fork, parallel authority, manual Buildchain allowlist, or
  separate Assignment closure;
- complete platform and public-surface declarations;
- scenario-bound generated receipts for repeat, crash, interruption, stale
  state, revoked Warrant, provider switch, projection rebuild, unreceipted
  external effects, and clean-runtime recovery.

Domain identity, legitimate authorization, success meaning, privacy boundary,
evidence strength, and consequence meaning remain explicit human declarations.
Their roots bind the scenario, domain Profile, field, status, and statement.
Missing or re-rooted declarations are `unqualified`; the checker never invents
defaults.

## Verdicts and retained qualification

The result is one of `compatible`, `compatible-with-constraints`,
`profile-invalid`, `scenario-incompatible`, or `unqualified`. Diagnostics carry
stable codes and exact evidence roots. Generated qualification covers Agent
Work, Week/Day/Action, and Course Production. The generator derives authority
roots from current repository bytes and produces fault receipts whose identity
and idempotency fields are tested; source acceptance rejects stale generated
evidence.

Buildchain admission is not inferred from prose. The retained envelope binds
the Buildchain authority file, provider, runner, exact source revision, source
root, and checked artifact roots. Missing, stale, incompatible, mismatched, or
manually allowlisted evidence fails closed.
