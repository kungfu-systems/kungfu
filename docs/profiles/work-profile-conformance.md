# Work Profile Conformance

The Work Profile Conformance Gate is a required, read-only qualification of a
Work-capable Profile. It decides whether one declared domain mapping preserves
Kungfu's existing Fact/Episode, Action Geometry, Work lifecycle, Cut, and
high-level Work API authority. It does not install or activate a Profile, create
an Assignment, settle Work, or introduce another registry or execution engine.

## Public Profile integration

A Work-capable Profile suite must contain the exact content reference
`work.conformance`. Work capability is detected from the Profile action registry:
the completion claim, completion review, and continuation decision actions must
all execute through `episode.append`. Removing only the conformance reference is
therefore rejected rather than silently opting the Profile out. The existing
`kungfu profile validate` and
`kungfu profile qualify` paths verify the referenced bytes and invoke the same
checker. Both responses expose `workConformance` with the same declaration
root, conformance root, verdict, constraints, diagnostics, residual risk, and
non-claims. Profiles outside the Work capability boundary retain their existing
behavior and report no Work conformance result.

The source checker remains available for authoring and repository
qualification:

```sh
./shifu work-profile:conformance -- --declaration declaration.json --surface validate --json
./shifu check:work-profile-conformance
```

Every platform and Profile surface in the closed product set must be declared,
required, supported, and rooted. `not-relevant`, `unsupported`, and omission are
invalid; the declaration cannot erase a product surface to obtain conformance.

## Machine proofs and human declarations

The checker proves only retained, content-addressed properties:

- exact Action Geometry, domain Profile, five role schema, Work lifecycle,
  source, Buildchain, and high-level Work API coordinates;
- distinct Fact, Episode, Pursuit, Atlas, and Warrant responsibilities;
- no domain Core fork, parallel authority, manual Buildchain allowlist, or
  separate Assignment closure;
- complete platform and public-surface declarations;
- domain-neutral generated Action Loop witnesses, reused only after the
  scenario's exact bindings validate, for repeat, crash, interruption, stale
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

Buildchain admission is not inferred from prose. The retained KFD-7 product gate
binds the Buildchain authority file, provider, runner, exact source revision,
gate root, and the retained runtime reports reused by this qualification. It is
shared runtime-substrate evidence, not proof of a separate domain Profile.
Missing, stale, incompatible, mismatched, self-certified, or manually
allowlisted evidence fails closed.
