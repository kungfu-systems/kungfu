# Design Philosophy

Two choices in this repository look wrong at first glance, and both are
deliberate:

- **Validation is a structure here, not a discipline.** Most projects treat "use
  your own product" as something you are supposed to *remember* to do. Kungfu
  makes it un-skippable: the project builds and runs on its own core, so if a
  core capability regresses, **building kungfu itself fails first** — you cannot
  ship a broken core, because your own work stops.
- **The UI lives inside the core loop, not split out.** Conventional wisdom says
  keep a repository focused on its moat and factor the UI into a separate
  project. Kungfu deliberately carries its reference GUI and TUI in the same
  repo, because **the UI is the one surface no expert can route around** — it is
  how the maker is forced onto the same path a user walks.

Neither is an accident, and neither is the point on its own. Almost every shape in
this repository — including these two — follows from **two coupled first
principles**. This document states them and shows how the architecture falls out
of them, so you can understand *why* kungfu is built the way it is, not just
*what* it contains.

For the vocabulary used below (`kungfu`, `sdk`, `libkungfu`, `yijinjing`, journal,
zero-copy, …), see [`concepts.md`](concepts.md); for how the pieces are layered,
see [`architecture.md`](architecture.md); for specific decisions and their
rationale, see the [ADRs](adr/). For the public product
stance that connects these choices to agent work, release evidence, extension
trust, and known limits, see [`facts-before-trust.md`](facts-before-trust.md).

The product goal follows directly from this stance: Kungfu should make
fact-first responsibility the path of least resistance. A user who starts with a
practical need — inspect an agent run, verify an extension, understand a release,
recover a failed workflow — should naturally move through local facts,
responsibility state, and proof-backed control decisions because that is the
simplest reliable way the product works.

## The missing infrastructure layer: runtime facts

Kungfu is runtime fact infrastructure for the agent era. Its design target can
be located with three coordinates:

```text
shape:     SQLite
semantics: Git, but for runs rather than source code
mission:   a flight recorder with a qualification layer
```

In one sentence: **Kungfu aims to do for what actually happened during a run
what Git did for source history, while fitting into each language ecosystem the
way SQLite does.** The comparison describes the product's intended shape and
responsibility; it is not a shortcut around evidence. Current guarantees and
maturity remain grounded in [`contracts.md`](contracts.md) and
[`known-limits.md`](known-limits.md).

### Shaped like SQLite: embedded where the facts happen

SQLite is useful without requiring a database service to be deployed first. It
travels as a library, speaks through native language bindings, and writes at the
place where the application already runs. Kungfu follows that shape for runtime
facts: the fact source should live beside the work, not begin as a remote sample
sent to a mandatory service.

The intended adoption test is deliberately concrete: each supported ecosystem
should offer a five-minute `hello Episode` path with no action outside that
ecosystem. A Python or Node user should encounter a native package and native
API, not a foreign platform ceremony. Rust may add another native surface when
it earns its place, but it must not create another definition of causality,
receipts, manifests, or replay. Native surfaces are the reach; the C++ core and
declared schema are the semantic weight-bearing layer.

### Git semantics, applied to runs

Source code already has a first-class history object: a Git commit is bounded,
independently addressable, durable under pressure, and meaningful inside an
explicit trust boundary. Agent work needs an equivalent unit for execution
history. In Kungfu that unit is the
[`Episode`](episode-object-model.md): a bounded causal segment whose facts,
payload commitments, provenance, dependencies, and verification roots can be
inspected as one object.

The analogy is semantic, not literal. An Episode is not a commit, and replaying
a run is not checking out a tree. The useful correspondence is that a run stops
being an expendable stream of logs and becomes an object that can be named,
verified, exported, imported, compared, and projected into a reproducible
timeline under a declared policy. Git also demonstrates the adoption property:
developers do not change programming languages to use source history. Runtime
fact semantics should be just as language-neutral.

### A flight recorder, with qualification

A flight recorder preserves the evidence needed to reconstruct and attribute
what happened. Kungfu adds an active semantic layer: it should also be able to
qualify whether the declared evidence boundary is intact and which claims that
evidence can support. Recording, replay, attribution, `fsck`, manifests,
receipts, and qualification belong to one responsibility chain.

This does not mean recording every bit of machine state or claiming that every
external side effect can be replayed. The trust boundary must be explicit. If
required evidence is absent or unverifiable, the honest result is a contracted
capability or failed qualification, not a confident reconstruction assembled
from guesses.

### Two deliberate non-identities

The distinctions below are more important than the analogies because they
prevent the product from collapsing into an already named category.

**Kungfu is not observability.** OpenTelemetry, monitoring systems, and tracing
services are excellent at answering operational questions from telemetry. They
may sample, aggregate, or optimize for dashboards and fleet-scale diagnosis.
Kungfu's ledger has a different duty: preserve the declared, correctness-relevant
facts as a locally owned and checkable object. Monitoring asks, "How does the
system appear to be behaving?" A runtime fact ledger asks, "What accepted facts
show what happened, what can be reproduced, and who or what was responsible?"
The two can interoperate; one should not be mislabeled as the other.

**Kungfu is not a blockchain.** Both domains use words such as *ledger*,
*integrity*, and *trust*, but they solve different problems. A blockchain
coordinates consensus among parties that do not share an authority. Kungfu
records and verifies agent work for participants who need factual provenance
and accountability. It needs strict semantics, integrity checks, and explicit
source boundaries — not a consensus machine, a token, or a globally replicated
chain.

### Why this layer becomes necessary now

Code has Git. Data has databases. Metrics and traces have observability
systems. Execution itself rarely became a first-class durable object because a
traditional program's behavior was largely derived from code plus inputs; logs
were often enough to investigate the exceptions.

Agent work changes that premise. A run may depend on model behavior, context,
tool results, permissions, approvals, randomness, external systems, and choices
made during execution. The source code no longer determines the action history
by itself. **What actually happened** therefore becomes a first-class object
that must be recorded, replayed within declared limits, and qualified in its own
right.

That requirement determines the architecture. Facts must be captured where the
work happens, under runtime-native semantics, before they are reduced to remote
telemetry or a model's summary. The ecosystem surface can be polyglot; the
causal, manifest, receipt, and trust semantics cannot fork by language. This is
the empty layer Kungfu is built to occupy.

## Principle 1 — The machine adapts to the person

Kungfu absorbs toolchain and runtime complexity into the product so its users do
not have to assemble it themselves. The `kungfu` runtime embeds both a Python and a
Node runtime and brings a full development lifecycle, so most extension
development needs no separately installed language runtimes or package managers.
The project carries the complexity so the user does not.

This is the principle already stated at the top of
[`architecture.md`](architecture.md). It stays sustainable only while the
absorbed tooling rests on mainstream, well-maintained foundations — so
"modernize" here means *reduce both user friction and maintenance burden*, not
chase convergence for its own sake.

## Principle 2 — Reality sets the test, not the product

A product's quality is decided **first-person, by its maker actually using and
stressing it under real conditions** — not by analyzing requirements, building an
imagined product, and waiting for users to report after release whether they like
it.

This rests on a distinction:

- **Does it work / is it usable / does it solve the problem?** The maker can — and
  must — judge this first-person, and the judgment is hard to fake: if a demanding
  maker using it on real terms is not satisfied, it will not satisfy users either.
  This is a *falsifier*: failing it predicts failure with high confidence.
- **Do enough people want it, and how much?** This genuinely needs real users; it
  is the residual the maker cannot self-source.

The trap is letting the *product* set the conditions of its own test — the happy
path, the supported configuration, the convenient reference machine. A product
graded on its own preferred exam always passes. So the discipline is to let
**reality** set the test, and to make that test **structural** rather than a
matter of willpower, because "remember to evaluate it as a user" is not reliable.
The architecture below is how kungfu makes that test un-skippable.

## How the architecture follows from Principle 2

### The build runs on the product

Kungfu's own build is a closed loop that runs on the very capabilities kungfu
offers: the application SDK (`kungfu sdk`) runs on the `kungfu` runtime; assembling the
distribution exercises the SDK end to end. If a core capability regresses,
**building kungfu itself fails first** — so the maker cannot ship a broken core
without their own work stopping. This is the load-bearing self-bootstrap, set out
in [ADR-0009](./adr/ADR-0009-load-bearing-self-bootstrap.md):
the path a newcomer walks to adopt kungfu is the same path the project walks to
validate itself.

### The reference UIs are inside the loop, not bolted on

The reference GUI and TUI are not the product (the product is the capability SDK
and runtime). They are in the bootstrap for a specific reason: **the UI is the one
surface where an expert and a novice meet at the level of the senses.** An expert
can route around a rough library API using knowledge a newcomer lacks; nobody can
route around the UI — the pixels are the same for everyone. By making the maker
run through the same interface a user runs through (the TUI even boots through
`kungfu`), the maker's path is forced to converge with the user's, on the surface
where most usability failure actually lives.

This is why kungfu carries `gui`/`tui` in the same repository even though the core
advantage is the zero-copy core (`libkungfu`) and the `yijinjing` schema layout. It looks like
monorepo bloat; it is the price of keeping the maker honest about the user's
felt experience. The criterion it implies: **a component earns its place in the
bootstrap when it extends the chain to a real user-facing surface** — otherwise it
is pure cost and belongs elsewhere. (The forcing function only works if the
maker actually drives the UI for real work, not only in CI.)

### Run on the real machine — refuse the convenient substrate

Kungfu runs on the maker's actual hardware, including Apple Silicon / arm64,
rather than demanding a convenient reference rig. This is Principle 1 applied
reflexively: *the machine adapts to me; I do not migrate myself to suit it.*

It is also how latent failures get forced into the open. The journal's frame
publish protocol was accidentally correct on x86's strong memory ordering but
could tear under arm64's weaker ordering — **invisible to anyone who stayed on
x86**, and surfaced only by insisting that kungfu run on real arm64 hardware, then
constructing a stress test that forced the rare interleaving to manifest. See
[ADR-0001](./adr/ADR-0001-yijinjing-publish-barrier.md). The
general move: for failures that normal use will not reveal, **be your own
adversary** — build the test that forces them to manifest now, rather than waiting
for a production incident that a convenient platform would never trigger.

### A declared, published contract

Kungfu's data plane carries declared schema authority exposed to C++, Python,
and Node, not a language-local secret. Closed `yijinjing` kernel facts are Hana-described POD; open
and domain facts are `.fbs`-owned, and each structured fact has exactly one
owner. Because those contracts are published and the maker's own build consumes
them, contract failures surface at the SDK boundary the maker themselves uses —
not when an external consumer cannot read the data. ADR-0047 defines the current
split; ADR-0008 defines the closed layout invariant, while superseded ADR-0002
preserves the earlier migration history.

## The two principles are one stance

Refusing to make the user adapt to the machine (Principle 1) and refusing to let
the product dictate the terms of its own test (Principle 2) are the same act seen
from two sides. Insisting that kungfu run on your real arm64 machine *is* demanding
the machine fit you — and it is also what put a real correctness failure in front
of you before any user hit it.

Every ADR is a decision in service of these two principles. Reading the
[ADRs](adr/) in that light shows the architecture as a
single, coherent answer rather than a sequence of unrelated calls.

For distributed timelines, the same stance means Kungfu does not pretend to own
an impossible global clock. It records facts, causality, source provenance, and
the observer policy used to project concurrent facts into a stable view. The
load-bearing truth is not "this wall-clock order is reality"; it is "this view
can be reproduced from declared facts and policy." See
[ADR-0021](./adr/ADR-0021-observer-relative-timeline-projection.md).

## One move, used everywhere

Step back from the individual decisions and they collapse into a single act. Each
takes something that would normally be a *claim* — "it works," "it's compatible,"
"this release is good," "users will like it," "the contract holds," "it's easy to
set up" — something you could assert, defend on honor, smooth over with
convenience, or defer until later. Kungfu refuses to let it stay a claim. It welds
it to a structure where reality has to show the answer, first-person and now, with
no way to fake it:

- *"It works"* → the build runs on its own core, so a core regression makes
  building kungfu fail first
  ([ADR-0009](./adr/ADR-0009-load-bearing-self-bootstrap.md)).
- *"I'd know if users disliked it"* → the maker is forced into the user's seat, on
  real hardware — running on real arm64 is what surfaced a bug x86 would never
  reveal ([ADR-0001](./adr/ADR-0001-yijinjing-publish-barrier.md)).
- *"It's compatible"* → the layout *is* the ABI, a physical fact, not a version
  number to compare
  ([ADR-0008](./adr/ADR-0008-yijinjing-schema-layout-baseline.md)).
- *"This release is good"* → an un-cheatable pipeline decides, not any one person,
  not even the maintainers ([version & release design](version-release-design.md)).
- *"The contract holds"* → every structured fact has one declared schema owner
  that the maker's own build consumes
  ([ADR-0047](./adr/ADR-0047-authoritative-facts-hana-pod-or-flatbuffers.md)).
- *"It's easy to set up"* → the runtime physically absorbs the toolchain, so
  zero-setup is true rather than promised (Principle 1).

*Reality sets the test* (Principle 2) is this same move applied to one claim in
particular — whether the product works. The move is larger; the test is one of its
faces.

Why it is one move, and why it is worth the discomfort: a claim can be wrong and
you will not find out until it is expensive — a production incident, a user who
quietly leaves, a release that drifts. A structure makes the truth show up now,
cheaply, where you cannot look away. The trade is always the same: comfortable
assertions that fail expensively later, for uncomfortable structures that fail
cheaply now.

The concurrency barrier, the published contract, the UI inside the loop, the
layout invariant, the release pipeline, the absorbed toolchain — these are not six
clever decisions. They are one move, used six times: **never rest a load-bearing
truth on something that can lie or be skipped; weld it to something that cannot.**
That is the discipline the README opens with; the architecture is it, applied.
