# Why Kungfu?

Kungfu began with **功夫**.

The original name was not an English acronym. It came from the Chinese idea of
capability earned through disciplined practice: not one isolated technique, but
the foundation that makes difficult action possible. Names such as `yijinjing`
carry the same history inside the codebase.

As the product evolved, **KUNGFU** acquired a second meaning: a recursive
technical definition that describes what the system is becoming.

## The recursive definition

```text
KUNGFU
= KUNGFU UNGFU: Never Guess. Facts Unfold.

UNGFU
= UNGFU: Never Guess. Facts Unfold.
```

The first `K` points back to `KUNGFU`. The leading `U` in `UNGFU` points back
to `UNGFU`. The outer name and the inner core therefore carry the same
principle recursively:

```text
KUNGFU = KUNGFU + UNGFU + Never + Guess + Facts + Unfold
UNGFU  =          UNGFU + Never + Guess + Facts + Unfold
```

```text
Never Guess. Facts Unfold.
```

This definition adds a technical meaning to the name. It does not rewrite the
historical origin of Kungfu, and it does not introduce `UNGFU` as another
product or runtime.

## Never Guess

`Never Guess` does not forbid hypotheses, estimates, or human judgment. Those
are necessary whenever evidence is incomplete. It means that a load-bearing
claim must not silently promote a guess into fact.

An agent saying that work is complete is a Claim. A process exiting with zero
is a signal. A dashboard row is a Projection. Each may be useful, but none
should replace the Facts, Artifacts, Receipts, Cut, and Proof needed for the
decision at hand.

Kungfu therefore prefers an honest unknown, gap, conflict, or known limit over
a confident reconstruction that the available evidence cannot support.

## Facts Unfold

`Facts Unfold` does not mean that raw facts explain themselves. Facts need
declared schemas, provenance, causal relations, observer policy, and explicit
interpretation. The phrase means that understanding should be able to unfold
from preserved facts instead of being supplied only by an opaque summary.

Kungfu records runtime Facts in an append-first journal. From those Facts it can
build or rebuild Episodes, Projections, Timelines, historical queries, Proof,
and responsibility state. If an interpretation changes, the underlying record
remains available for another declared Projection or assessment.

```text
Facts are authoritative.
Projections are rebuildable.
Claims require Proof before they support Decisions.
```

This is the practical meaning of [Facts Before Trust](facts-before-trust.md).

## Deep integration outside, self-bootstrap inside

The recursive name also mirrors the product structure.

At the outside, Kungfu is deliberately integrated. The monorepo carries the
assembled App, GUI, TUI, CLI, language SDKs, KFX extension system, native core,
qualification contracts, and release machinery. A user can enter through one
complete product instead of assembling a platform first.

At the inside, authority does not depend on keeping every outer layer. The
journal-backed Facts and Episode contracts remain below the interfaces that
render or operate them. Removing the GUI does not remove headless operation;
removing one language host does not remove the native core; replacing a
Projection does not replace its factual basis.

That is the architectural form of recursion:

```text
integrated product
  -> independently useful layers
    -> libkungfu and Episode contracts
      -> journal-backed Facts
        -> rebuildable understanding
```

[Product Layers](product-layers.md) makes this boundary executable through
independent qualification and layer-deletion tests.

## The project must prove the name

A recursive definition is only wordplay unless the project follows it.

Kungfu therefore treats source, schemas, architecture decisions, known limits,
qualification evidence, and release provenance as parts of the product. The
source is open; higher-level claims are linked to inspectable contracts and
evidence; Buildchain binds release responsibility back to source and artifacts.

The project will not capture every machine state or eliminate every uncertain
judgment. Its stronger obligation is narrower: when a load-bearing claim can be
grounded in a preserved, inspectable fact, prefer the fact; when it cannot, make
the limit visible.

The name is a compact statement of that obligation:

```text
KUNGFU UNGFU:
Never Guess. Facts Unfold.
```

For the broader architecture and its deliberate trade-offs, continue with
[Design Philosophy](design-philosophy.md). For current guarantees rather than
design intent, read [Contracts](../qualification/contracts.md) and
[Known Limits](../qualification/known-limits.md).
