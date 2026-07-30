# Facts Before Trust

Kungfu starts from the rule KFD makes explicit:

```text
A load-bearing claim should never stand alone. Bind it to a verifiable source,
artifact, manifest, or runtime receipt before treating it as trusted state.
```

That rule is the concrete form of facts before trust: do not ask users to trust
a claim when the system can produce a fact. It is why Kungfu is journal-first.
It is why replay runs on the same runtime as live. It is why known limits are
written down instead of hidden. It is why release, provenance, extension trust,
and agent-facing skills are treated as part of the product rather than
paperwork around it.

Kungfu is built for work where claims are not enough:

```text
it worked
the run finished
the artifact is safe
the replay is faithful
the extension is trusted
the agent did the work
```

Each of those statements is cheaper to say than to prove. Kungfu's design bias
is to turn the statement into a local, inspectable, replayable, or otherwise
verifiable object.

## Product Goal

Kungfu should make fact-first responsibility the path of least resistance.

Users should not need to adopt a philosophy before the product helps them. They
may arrive because an agent run failed, a long task is burning tokens, an
extension needs review, or a release artifact needs proof. But after the first
use, the easiest reliable path should be the Kungfu path:

```text
capture the work
inspect the local facts
understand the responsibility state
decide the next action from proof
keep the record exportable and reviewable
```

This is how the product carries the principle instead of merely describing it.
The interface, runtime, extensions, skills, and release evidence should make
the fact-first path feel cheaper than guessing, asking for summaries, or
trusting an opaque control plane.

## Facts Before Trust

A user should not have to trust a dashboard, a hosted service, a maintainer, or
a model summary before they can understand what happened.

Kungfu therefore puts the fact source close to the work:

- an append-first journal rather than only mutable final state;
- declared schemas rather than hidden in-process conventions;
- replay on the same runtime rather than a separate storytelling engine;
- portable exports rather than a service that must still exist later;
- explicit maturity and known limits rather than overclaiming.

Trust still matters. But in Kungfu, trust should be earned from facts that can
be inspected by people, agents, and future maintainers.

## Local Proof Before Control

Agent work makes this more important, not less.

As agents become more capable, the hard user questions move from "can it act?"
to:

```text
What happened?
Was it actually finished?
Was money, time, or attention wasted?
Which tool, account, model, file, or approval boundary was involved?
What proves the result?
What should happen next?
```

Adding more rules is not enough if the work itself remains opaque. Moving more
execution into a cloud control plane is not enough if the user cannot inspect
the facts. Kungfu's stance is:

```text
facts before trust
local proof before control
accountability before automation
```

Control decisions should grow from a stable fact source: status, evidence,
blockers, costs, approvals, artifacts, and recovery paths that can be reviewed
after the run.

## Transparency Is A Mechanism

Transparency is not decoration. It is how this structure travels.

If a project says it is accountable but its source, build, release, provenance,
limits, and decision records are not inspectable, users must fall back to trust.
That may be acceptable for some products, but it is not the proof Kungfu is
trying to provide.

Kungfu's own path should follow the same shape it asks users to rely on:

```text
claimed structure:
  complex work -> fact source -> responsibility -> mechanism -> reviewable trust

proof structure:
  Kungfu source -> build/release evidence -> documented decisions -> known limits -> reviewable trust
```

This is why open source, buildchain-level auditability, release evidence,
architecture decisions, and known limits belong together. They let a reader
audit not only the code, but the way the project becomes something users can
depend on.

Transparency also gives the design a clean boundary. A system that hides its
fact source, blurs responsibility, or asks users to accept unreviewable claims
may still be useful, but it is not following this pattern.

## Load-Bearing Self-Bootstrap

Kungfu should prove itself by using the same structures it asks others to use.

The adoption path and the validation path should converge. The runtime powers
the SDK. The SDK builds real extensions. The reference GUI and TUI exercise the
same capability layer a user sees. Release gates should bind source, artifact,
and provenance instead of leaving them as separate claims.

This is the public engineering version of the bootstrap rule:

```text
the proof path must exercise the thing being proved
```

When that holds, a maintainer does not need to remember to keep the core honest.
The project runs through its own core, so a broken core stops the project's own
work first. Users do not need to trust a separate demo because the real stack is
the demo.

## What This Means In The Repository

This principle shows up in several concrete places:

- `yijinjing` journals are the append-first fact layer.
- `yijinjing` schema makes the binary layout a declared contract.
- replay reuses the live runtime instead of inventing a separate replay story.
- `docs/qualification/contracts.md` states guarantees with maturity and verification paths.
- `docs/qualification/known-limits.md` names what is not yet guaranteed.
- KFX trust gates separate user-authored capability from runtime authority.
- Kungfu Skills keep cost, state, proof, audit, and recovery visible when agents
  work through skills.
- release and buildchain work exists to connect source, binaries, provenance,
  and release responsibility.

The exact implementation will keep evolving. The direction should not: if a
load-bearing claim can be replaced by a fact, Kungfu should prefer the fact.

## What This Does Not Mean

This is not a claim that every fact can be captured perfectly. Runtime journals
are a low-loss record of important events, not a total recording of all machine
state. Some memory, timing, external service state, user judgment, and
non-deterministic side effects will remain outside the ledger.

This is not a claim that cloud services are bad. Hosted systems can be useful,
especially for teams, search, storage, compute, and collaboration. The rule is
that hosted convenience should not be the only place where truth exists.

This is not a claim that users must publish private work. Privacy boundaries are
part of accountability. The goal is to make the fact path inspectable by its
owner and exportable when the owner chooses.

This is not a moral judgment against every opaque system. It is a design choice
for Kungfu: when work becomes complex, start with facts before asking for trust.
