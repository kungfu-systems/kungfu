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

For the vocabulary used below (`kungfu`, `kfs`, `libkungfu`, `longfist`, journal,
zero-copy, …), see [`concepts.md`](concepts.md); for how the pieces are layered,
see [`architecture.md`](architecture.md); for specific decisions and their
rationale, see the [ADRs](../framework/core/docs/adr).

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
offers: the application SDK (`kfs`) runs on the `kungfu` runtime; assembling the
distribution exercises the SDK end to end. If a core capability regresses,
**building kungfu itself fails first** — so the maker cannot ship a broken core
without their own work stopping. This is the load-bearing self-bootstrap, set out
in [ADR-0009](../framework/core/docs/adr/ADR-0009-load-bearing-self-bootstrap.md):
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
advantage is the zero-copy core (`libkungfu`) and the `longfist` layout. It looks like
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
[ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md). The
general move: for failures that normal use will not reveal, **be your own
adversary** — build the test that forces them to manifest now, rather than waiting
for a production incident that a convenient platform would never trigger.

### A declared, published contract

`longfist` is a declared schema generated for C++, Python, and Node, not a C++
internal secret. Because the contract is published and the maker's own build
consumes it, contract failures surface at the SDK boundary the maker themselves
uses — not when an external consumer cannot read the data. See
[ADR-0002](../framework/core/docs/adr/ADR-0002-longfist-flatbuffers-runtime-schema.md)
and [ADR-0008](../framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md).

## The two principles are one stance

Refusing to make the user adapt to the machine (Principle 1) and refusing to let
the product dictate the terms of its own test (Principle 2) are the same act seen
from two sides. Insisting that kungfu run on your real arm64 machine *is* demanding
the machine fit you — and it is also what put a real correctness failure in front
of you before any user hit it.

Every ADR is a decision in service of these two principles. Reading the
[ADRs](../framework/core/docs/adr) in that light shows the architecture as a
single, coherent answer rather than a sequence of unrelated calls.

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
  ([ADR-0009](../framework/core/docs/adr/ADR-0009-load-bearing-self-bootstrap.md)).
- *"I'd know if users disliked it"* → the maker is forced into the user's seat, on
  real hardware — running on real arm64 is what surfaced a bug x86 would never
  reveal ([ADR-0001](../framework/core/docs/adr/ADR-0001-yijinjing-publish-barrier.md)).
- *"It's compatible"* → the layout *is* the ABI, a physical fact, not a version
  number to compare
  ([ADR-0008](../framework/core/docs/adr/ADR-0008-longfist-schema-evolution-and-minor-maintenance.md)).
- *"This release is good"* → an un-cheatable pipeline decides, not any one person,
  not even the maintainers ([version & release design](version-release-design.md)).
- *"The contract holds"* → it is a declared schema that the maker's own build
  consumes ([ADR-0002](../framework/core/docs/adr/ADR-0002-longfist-flatbuffers-runtime-schema.md)).
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
