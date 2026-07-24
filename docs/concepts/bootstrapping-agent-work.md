# Kungfu as a Bootstrapping System

Kungfu is building infrastructure for durable agent work while using agents to
build more of that infrastructure. This essay examines that loop, the human
responsibility that remains, and the evidence required before a private
bootstrap can be called public infrastructure.

This is an explanation of product intent, not a new runtime guarantee. Kungfu
v4 is **Coming soon**. The repository contains source-built capabilities,
merged mechanisms, and qualification slices, but they are not all one generally
available product yet. Current guarantees remain owned by
[Contracts](../qualification/contracts.md),
[Known Limits](../qualification/known-limits.md), and retained qualification
evidence.

The rendered reading edition is also available at
[kungfu.tech/about/bootstrapping](https://kungfu.tech/about/bootstrapping/).

## Read This With Your Agent

This is an argument, not a product tutorial. If the logic feels dense, ask an
agent to interpret it with you. Do not ask it merely to summarize or agree; ask
it to separate evidence from hypothesis and challenge the reasoning.

```text
Read this page as an argument, not as marketing.

1. Explain its central claim in plain language.
2. Separate current evidence, strategic hypotheses, and long-term aspirations.
3. Explain Session continuity versus Work continuity using an example from my
   own work.
4. Map Fact, Claim, Proof, Decision, and Admission onto that example.
5. Give the strongest counterargument and say what evidence would falsify the
   thesis.
```

The purpose is not to make an agent persuade the reader. The purpose is to let
the reader use an agent as an interpreter and critic while retaining judgment.

## The Hidden Runtime Is Still Human

Today's agents can write code, search, call tools, and carry out long chains of
action. But a person usually remains continuously present behind the work.

The person remembers the real goal, notices when context is missing, decides
which sources are credible, limits authority, catches duplicated side effects,
reconciles several agents, and decides whether the result is actually complete.

That person is doing more than supervising a model. The person is acting as an
invisible Work Runtime:

- fact ledger;
- direction keeper;
- authority issuer;
- exception handler;
- causal historian;
- final settlement layer.

If agents remain assistants, that arrangement can work. If agents are to carry
most executable, recordable, and verifiable work while people retain direction,
risk boundaries, exceptions, and final acceptance, those hidden functions must
become infrastructure.

## A Session Is Not The Work

A Session is a useful container for conversation, model context, tool calls, a
process, or a billing interval. It does not, by itself, establish what remains
the same work after the Session ends.

It cannot naturally decide:

- which statements became Facts;
- whether a successful command completed the real objective;
- whether another agent inherits authority;
- whether a retry will repeat an external effect;
- who may admit the final result.

The difference can be stated plainly:

> **A Session lets an agent continue talking. Work infrastructure lets the work
> continue to exist.**

Longer context, summaries, memory, checkpoints, workflows, and supervisors are
all useful. But they can keep improving the execution container without
creating a durable Work identity with its own facts, direction, authority,
history, assessment, and admission.

## Freedom Needs An Authority Boundary

Kungfu does not begin from the promise that agents will stop making mistakes. A
sufficiently capable agent will still work with incomplete information,
uncertain models, changing external systems, and fallible tools.

The more practical question is whether an error can silently acquire authority:
become a Fact without admission, expand a Warrant, repeat a real-world effect,
or promote itself into completed work.

> **Let agents freely produce candidates. Do not let them freely produce
> authoritative reality.**

This is not a way to weaken agents. It is what can make delegation larger. When
facts cannot drift silently, authority cannot expand silently, and completion
cannot be self-certified by the executor, people can allow agents to work
longer and across more consequential systems.

## The Bootstrapping Problem

Reliable long-running agent work needs a durable Work layer. Building that
layer is itself long-running, cross-session, multi-agent work. The system is
needed before the system can be built.

Kungfu starts with a deliberately smaller loop:

```text
current agents + concentrated human judgment
-> a minimal durable fact and responsibility layer
-> more reliable agent work
-> less human reconstruction and micro-supervision
-> a larger share of the system built by agents
-> a stronger durable work layer
```

Human judgment does not disappear. It moves away from continuous clerical
reconstruction and toward fewer, higher-weight sovereignty points: direction,
authorization, exception adjudication, and admission.

This is a description of Kungfu's present strategy, not a claim that every
project must begin with one person or follow the same path.

## With Gratitude To Douglas Engelbart

Douglas Engelbart was a pioneer who made bootstrapping collective
intelligence a deliberate system strategy. A team improving the tools and
practices of collective work should use its own emerging results to improve its
ability to make the next results. The improvement process should improve itself.

That strategy was broader than software dogfood. Engelbart connected tools with
language, methods, roles, organizational structures, and an evolving shared
knowledge environment. His goal was not to automate people out of the loop, but
to increase the capability of people working together on complex and urgent
problems.

Kungfu is not presented as an official continuation of Engelbart's work. It is
a project in a different era, facing a new responsibility boundary. But the
intellectual debt and structural kinship are clear: use the system under
construction to improve the collective capability constructing it.

The Doug Engelbart Institute provides introductions to
[bootstrapping](https://www.dougengelbart.org/content/view/226/269/) and
[Collective IQ](https://dougengelbart.org/content/view/225/).

## The Public System Boundary

Kungfu's public architecture separates several responsibilities so the
bootstrap does not turn one implementation into universal authority.

| Layer | Public responsibility |
| --- | --- |
| `libkungfu` and `yijinjing` | The local-first, journal-first runtime substrate for durable Facts, causal Episodes, replay, export, and recovery within declared limits. |
| Kungfu | The product and reference runtime that make durable agent work usable by agents and understandable to the people who retain authority. |
| KFD | The open, topology-neutral protocol for carrying bounded responsibility between independently owned systems. Its normative meaning is not owned by a private Hub. |
| Buildchain | The public release-responsibility layer that binds claims to exact source, artifacts, evidence, known limits, and approval. |

These layers are related, but they do not prove one another by association:

```text
coherent design
!= merged implementation
!= qualified capability
!= released product
!= independent adoption
```

The exact implementation and qualification boundaries are documented in
[System Overview](system-overview.md),
[Fact, Episode, and Action Primitive Runtime](../architecture/fact-episode-action-runtime.md),
[Agent Supply Chain](../architecture/agent-supply-chain.md), and
[Product Layers](product-layers.md).

## What The Bootstrap Proves

Using Kungfu's own ideas while building Kungfu can prove that the loop is
possible and useful to its builders. Several public mechanisms contribute to
that existence proof:

- the journal and Episode runtime preserve important work facts as durable
  objects rather than disposable conversation;
- agent-facing context and capability surfaces make source work less dependent
  on one model's memory;
- independent Decisions, Project Cuts, and Receipts separate executor output
  from accepted completion;
- public source, bounded claims, retained evidence, and Buildchain Release
  Passports make release statements inspectable.

The evidence for each mechanism must still be read at its own maturity. A
merged design or source implementation is not a released product guarantee.

## What It Does Not Prove

A private loop can become an elaborate cognitive exoskeleton for one founding
context. Internal usefulness does not prove universality.

The stronger test requires:

- unfamiliar teams and domains;
- independent implementations;
- external corrections that change the system;
- admission that does not depend on the original executor;
- authority that can move beyond the original author;
- a first-use experience that does not require learning the whole ontology.

A self-bootstrapping design should also remain replaceable in parts. Every
piece of complexity should answer a real failure mode, expose a negative test or
counterexample, allow independent verification, and admit a simpler successor
when one can carry the same responsibility.

## How This Thesis Can Fail

The thesis does not succeed because its vocabulary is internally consistent. It
succeeds only if people and agents outside the founding context receive
practical value without first learning the entire model.

The first test is intentionally ordinary:

```text
the chat or agent Session ends
-> the Work remains
-> a fresh agent knows what happened and what remains
-> the person does not reconstruct the task from memory
```

That first contact is defined in the repository [README](../../README.md) and
bounded by the current [continuity qualification](../qualification/continuity-pilot.md).
It is preparatory evidence, not yet proof of multi-day durability or superiority
over current provider-native continuation.

Beyond that, Kungfu must show that independent readers can inspect what it
claims, independent builders can implement or integrate the boundary, and users
can leave with their facts and meaning intact. If it cannot do those things,
the bootstrap has not become public infrastructure.

## Why Build This Way?

Kungfu is trying to build a system in which agents can carry more of the work
without asking people to surrender understanding or authority. It is using
agents to build more of that system, while making the resulting claims
answerable to public facts.

That recursive loop is not evidence that the destination has been reached. It
is the method by which the project intends to find out whether the destination
is reachable.

Continue with [Facts Before Trust](facts-before-trust.md),
[Design Philosophy](design-philosophy.md), or
[Known Limits](../qualification/known-limits.md).
