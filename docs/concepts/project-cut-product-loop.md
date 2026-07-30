# The Project Cut Product Loop

Kungfu should make long-running agent work feel like one understandable loop:

```text
current Project Cut
  -> agent executes bounded work
  -> next Project Cut is settled
```

A user should not need to learn every internal object before this loop becomes
useful. The lower layers exist so that the simple surface remains truthful when
work spans chats, agents, machines, repositories, or days.

## What the user sees

A **Project Cut** answers one practical question:

> What has this project officially become at this point?

It is a versioned, verifiable commitment that binds the accepted source
projection, Atlas, admitted Episode change, applicable policy and protocol,
and known omissions or conflicts. It does not copy those authorities into one
large document or replace them with a fourth fact engine.

The default experience therefore has three visible moments:

1. inspect the current Project Cut;
2. let an agent perform the selected work; and
3. inspect and explicitly settle the candidate next Project Cut.

For short, low-risk work, this may be the entire product vocabulary a user
needs.

## When work needs more structure

Longer work exposes two Agent Work terms between successive cuts:

- an **Initiative** is a continuing body of intended project change; and
- an **Assignment** is a bounded unit of accepted responsibility within one or
  more Initiatives.

Initiative and Assignment are product terms in the Agent Work Domain Profile.
They do not replace the cross-domain Pursuit, Atlas, and Warrant responsibilities:

- Initiative projects continuing direction from Pursuit;
- Assignment binds direction, accepted perspective, authority, and success
  conditions for one bounded responsibility; and
- the resulting Episode, Claim, Assessment, and Decision provide the evidence
  required before a successor Project Cut can be settled.

This is progressive disclosure, not hidden semantics. Every default remains
inspectable, replaceable, exportable, and independently invalidatable.

## The layers behind the loop

```text
product settlement
  Project Cut

Agent Work organization
  Initiative / Assignment

cross-domain responsibility
  Pursuit / Atlas / Warrant

contract-world ontology and runtime
  Fact / Episode
```

Claim, Assessment, Decision, and their evidence form the trust path across the
layers. They determine whether observed work is admissible to a new project
commitment; they are not another storage hierarchy.

The lower layers are not a menu that every user must operate manually. They
are the semantic kernel that prevents a concise product surface from reducing
long-running work to chat history, mutable status, or an unverified summary.

## Product entrypoint

The target primary command is:

```sh
kungfu cut
```

With no mutating option, it must only inspect the current project state, active
work, pending settlement, and actionable degradation. It must not create
`.kungfu`, advance a ref, accept a Claim, or settle a cut.

Explicit subcommands prepare, verify, settle, inspect history, and export cuts.
The GUI, TUI, CLI, and agent interface must project the same contract and
receipts. A convenient surface may hide detail, but it may not create private
authority or stronger proof.

## Current implementation boundary

The repository already implements the frozen `project.cut/v1` protocol and an
agent-first `./shifu project-cut` settlement workflow. Mission and Go are the
current Agent Work compatibility projection and have a qualified native
authority cutover path.

This product decision does not reinterpret those roots, identifiers, or
receipts. Initiative and Assignment are the target product language. Moving
persisted Mission/Go state or public commands to that language requires an
explicit, versioned KFD-1 migration with retained readers, exact mappings,
differential evidence, and rollback. Until that cutover, the existing commands
and records keep their documented meaning.

See [KF-ADR-019f86da-4f90-7a57-a680-9739f5e67173](../adr/KF-ADR-019f86da-4f90-7a57-a680-9739f5e67173.md) for the
decision, the [architecture design](../architecture/project-cut-product-loop.md)
for the first implementation shape, and the
[release qualification](../qualification/project-cut-product-loop.md) for the
v4 product gate.
