# KFX Profile Suite lifecycle

The Profile lifecycle turns a schema-valid `kungfu.profile-suite/v1`
document into append-only workspace facts without making Profile JSON, a GUI,
or an extension package a runtime authority.

## Authority and identity

Core embeds the exact `kungfu-kfx.contract.json` document and validates its
`profileSuiteSchema`. Inspection then verifies every referenced artifact's
SHA-256 and confines real paths to the Profile package directory. Core requires
one canonical `sha256:...` root for every required and optional Suite member.
The low-level API accepts those roots explicitly; the installed Agent Profile
SDK resolves them from exact package bytes. Missing, extra, duplicate,
malformed, or changed roots fail closed.

Core computes `profile_suite_root` over:

- the normalized Profile document;
- the exact KFX source-contract root;
- every verified facet path, SHA-256, and byte length;
- every resolved Suite member root.

The source cannot declare its own Profile root. Whitespace and input member
ordering do not change identity; content, authority-contract, or member-root
changes do.

## Lifecycle facts

`Installed`, `Qualified`, `Activated`, `Superseded`, `RolledBack`, and
`Removed` are FlatBuffers-owned events inside an ActionEnvelope. Each event is
attached to an Episode and appended under the workspace runtime journal at
`profile/lifecycle`. Current state and historical cuts are deterministic folds
over that journal; no `profile-catalog.json` sidecar is authoritative.

Installed, qualified, and activated are distinct. Activation requires the
exact current root to have a prior qualification fact and refuses grants not
declared by a bound `kungfu.profile-permissions/v1` registry. GUI focus is not a
lifecycle state. Multiple Profiles may remain active in one workspace.

The S1 qualifier executes only two checks:

- `content-closure`;
- `runtime-contract`.

The bound compatibility artifact must use
`kungfu.profile-compatibility/v1` and include
`kungfu.profile-lifecycle/v1`; the qualification artifact must use
`kungfu.profile-qualification/v1` and request exactly those two supported
checks. Unsupported checks fail instead of being reported as passed.

## Plan and apply

All mutations use the same operation from C++, Python, Node, and CLI:

```text
inspect -> plan -> authorize -> apply -> receipt -> get/history
```

`plan` records the target runtime, current root/revision, verified inspection,
permissions, qualification result, and typed effects. `apply` requires an
authorization id, recomputes the plan, and rejects any change in source bytes,
member roots, current lifecycle basis, permissions, target runtime, or plan
identity.

Use `kungfu profile --help` for the plan-first Agent interface, or
`kungfu kfx profile --help` for the low-level lifecycle surface. `get
--cut-system-time` reads the historical fold; `history` retains lifecycle facts
after rollback or removal.

## Composition and coexistence

Activation does not silently materialize KFD-1 declarations. The public
Profile contract plan is separately authorized and then uses the existing
contract-world and fact-surface admission authority. Views resolve through
KF-ADR-019f86da-4f90-7e38-b72f-ef8829e14104 QueryDefinitions; KFD-2 claims resolve through KF-ADR-019f86da-4f90-7b3f-9ef3-84f5a878f302 assessment
plans. Exact Suite, catalog, member, policy, definition, proof, Episode, and
claim-instance roots remain visible in plans and receipts.

Mission Control is a first-party `kungfu.profile-suite/v1`, not a privileged
Core path. It can coexist with independently authored Profiles in one runtime.
Profile activation is not GUI focus, and removing a Profile does not delete its
admitted facts or historical lifecycle events.

Source portability also remains separate from lifecycle. Full Profile bundles
can reconstruct exact source bytes and thin bundles can verify roots and file
inventory. Import writes source into an empty destination only; it does not
install, qualify, activate, grant permissions, admit evidence, or assert trust.
Fact Library bundles carry admitted evidence through their own authority.

## Current boundary

The installed Agent SDK, runtime-discovered GUI Profile Manager, generic view
composition, Mission Control reference Suite, and independent Week/Day/Action
qualification are implemented. The current product claim is pre-release and
qualified on macOS ARM64; it is not yet a cross-platform stable compatibility
promise, marketplace, no-code ontology builder, remote Profile registry, or
cryptographic actor-identity system.

A lifecycle receipt proves the recorded transition and bound closure. A query
receipt proves the answer at its declared cut. An assessment receipt proves the
specified claim/purpose/evidence evaluation. None of those receipts alone
proves that a user's source assertion is universal external truth or that a
domain action achieved its real-world purpose.
