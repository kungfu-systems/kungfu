# ADR-0009: Load-bearing self-bootstrap — the adoption path is the validation path

- Status: accepted (the principle; it names a structure the repository already
  embodies — see "Instances in the repository today"). Governance to keep new
  rings load-bearing rather than wrapping is a standing review obligation, not a
  one-time build step.
- Date: 2026-06-30
- Category: (principle) product-layer first principle — names and generalizes
  the property that "the build dogfoods the SDK" (`docs/architecture.md`) was a
  single instance of.
- Subsystem: whole product — runtime (`framework/core`/`kungfu`), capability SDK
  (`framework/api`), application SDK (`developer/sdk`/`kfs`), reference surfaces
  (`framework/gui`, `framework/tui`), distribution (`artifact`).
- Related: the dynamic counterpart to the version mechanism's
  weak-centralization (`docs/version-release-design.md` — "un-cheatable
  pipeline", "weak-centralization"); shares the longfist-as-true-invariant
  ordering with [ADR-0008](ADR-0008-longfist-schema-evolution-and-minor-maintenance.md);
  the build-layer instance is [`docs/architecture.md` § The build dogfoods the
  SDK](../../../../docs/architecture.md).

## Decision

Adopt **load-bearing self-bootstrap** as a product-layer first principle, in two
inseparable clauses:

1. **Structural clause — the adoption path is the validation path.** The path a
   newcomer walks to evaluate the product (install `artifact` → run the GUI/TUI
   → build a `kfx` → package with `kfs`) is, layer for layer, the same path the
   project walks to validate itself. There is no separate demo, test rig, and
   product: one artifact is all three. Every outer ring must be a **load-bearing
   consumer** of the inner ring, never a wrapper around it.

2. **Dynamic clause — upkeep is a byproduct of use.** Because each ring actually
   runs on the ring beneath it, a regression in the core is *self-punishing*
   inward (the maintainer's own build, UI, and tooling stop first) and the
   core's health is *self-evident* outward (the whole visible stack is running
   on it right now — a costless, un-fakeable signal that removes the need for
   trust). The energy that keeps the core healthy therefore comes from **use**,
   not from **discipline** — which is why it does not decay.

The machine-fits-human principle (`docs/architecture.md`) is the user-facing
*promise*; this ADR is the engine that makes the promise **un-fakeable and
self-sustaining**.

## The engine (three steps, none skippable)

1. **Load-bearing coupling (the precondition).** Each ring genuinely consumes
   the ring beneath it — `kfs` runs *on* `kungfu`; the TUI starts *through* `kungfu`'s
   Node runtime. This step is the switch: degrade any ring into a wrapper / mock
   / optional side path and steps 2–3 break at once.

2. **Regression is self-punishing (the inward force).** When the core regresses,
   the first thing that dies is the maintainer's own hands — the build stalls,
   the UI will not start, the development toolchain breaks. Maintaining the core
   stops being a *deferrable obligation* and becomes a *prerequisite for getting
   any work done today*.

3. **Health is self-evident (the outward force).** The entire visible stack runs
   on the core right now — which is a zero-cost, un-fakeable health signal to a
   prospective user. It removes the need to *trust* a claim in the docs.

One structure, two outputs: a forcing function on the maintainer (inward) and
the elimination of required trust for the user (outward).

## Why this is "vitality", literally

The defining mark of a living system is **self-sustenance**: it metabolizes to
stay alive rather than depending on an external party to keep pouring in
willpower. This structure is powered by "use metabolizes the core" — that is the
literal mechanism of its aliveness, not a metaphor.

Read it as an energy account, against this project's real constraint (a
junior-heavy, high-turnover contributor pool — see
`docs/version-release-design.md`):

- **Discipline** is a scarce energy source that *decays* with turnover. A core
  maintained by discipline alone eventually loses its supply.
- **Self-interest** is an abundant, self-renewing source. "If I don't keep the
  core healthy I literally cannot work" is topped up automatically, by everyone,
  every day.

The mechanism relocates the energy of maintenance from discipline to
self-interest. That relocation is what gives the structure life. It is the
product-layer instance of replacing reliance on individual talent/will with a
mechanism that supplies its own energy.

## Relationship to the existing principles

| Existing principle | Relationship |
|---|---|
| "The build dogfoods the SDK" (`docs/architecture.md`) | A single **instance** of this principle at the build layer. This ADR is its general law; that section is now read as one consequence. |
| Adoption-path identity | The **structural clause** above. On its own it is only an architecture diagram — it needs the dynamic clause to explain why the arrangement produces anything. |
| Weak-centralization / un-cheatable pipeline (`docs/version-release-design.md`) | A **sibling** in the same family — *replace trust/judgment with structure* — applied to a different object: that one governs release-worthiness, this one governs capability health and the energy of its upkeep. |
| longfist layout as true invariant ([ADR-0008](ADR-0008-longfist-schema-evolution-and-minor-maintenance.md)) | Supplies the **safety ordering** this principle depends on (see boundary 2): the rings everything bootstraps onto are the ones that change least. |

## Instances in the repository today

This principle is descriptive before it is prescriptive — the repository already
runs this way. The rings, from the core outward, each both extend capability and
consume (hence validate) the ring beneath:

- **libkungfu** — the polyglot membrane: zero-copy cross-language access plus the
  longfist binary layout. The base everything else bootstraps onto.
- **kungfu** — the first-layer binary. It embeds a Python and a Node runtime and
  loads libkungfu's companion bindings (`py_kungfu`, `kungfu_node.node`)
  in-process. *First bootstrap:* the runtime is itself a consumer of the membrane.
- **kfx development toolchain** — `kungfu` bridges a full Python lifecycle
  (dependency management, ahead-of-time compilation via `kungfu engage`); the
  repository's own `kfx` extensions are built through it. *Bootstrap:* the repo's
  own build is a user of the toolchain `kungfu` ships.
- **Reference surfaces (GUI / TUI)** — no paradigm innovation (Electron/React,
  Ink); their job is to let a human *see* libkungfu's capability rather than read
  about it. They load the binding in-process to preserve zero-copy, and the TUI
  starts through `kungfu`'s Node runtime — repeatedly re-exercising `kungfu` on every
  launch.
- **Application SDK (`kfs`)** — supports building/packaging extensions, yet `kfs`
  itself launches on `kungfu` as its runtime, so a user develops a `kfx` with no
  separately installed Node or Python. *Bootstrap:* `kfs` is a consumer of `kungfu`.
- **`artifact`** — bundles `kungfu`, the reference surfaces, and `kfx`, and is
  assembled *using* `kfs`. *Bootstrap:* assembling the installer is the real test
  that `kfs` can package a complete application.

Three instances are easy to miss and worth naming explicitly, because they are
the ones that close the loop:

- **Stage-0 bootstrap (the compiler analogy).** `kungfu` *embeds* runtimes for the
  user, but *building* `kungfu` needs a Python/Node toolchain that does not yet
  exist inside it — supplied externally by `./kungfu-code` (Node via fnm, Python
  via uv, the package manager via Corepack). There is a handoff: an external
  stage-0 toolchain produces `kungfu`, after which `kfx` development switches to
  `kungfu`'s own embedded toolchain. This is exactly a self-hosting compiler's
  stage-0 → stage-1: borrow an external compiler once, then self-host.
- **Single-schema codegen.** The membrane's cross-language identity ("C++,
  Python, and Node read the same layout") is not hand-synchronized; it is
  *generated* from one source — the longfist `*.fbs` through `flatc` into all
  three language bindings (see [ADR-0008](ADR-0008-longfist-schema-evolution-and-minor-maintenance.md)).
  Consistency is bootstrapped from a single definition rather than maintained by
  hand in three places.
- **Deterministic replay (the time axis).** Live and replay run on the *same*
  runtime and the *same* journal semantics. The system's own output (the
  journal) is therefore the input that validates its own determinism — there is
  no second replay engine. The proof folds back onto the producer across time.

## Boundary and falsification

A principle has to say when it does *not* hold. Load-bearing self-bootstrap
produces vitality only while all four conditions hold; each maps to one part of
the engine:

1. **Load-bearing, not wrapping** (protects step 1). The consumer must genuinely
   fail when the inner ring breaks. A wrapper, a mock, or an optional bypass on
   the adoption surface severs both the inward forcing function and the outward
   proof — it is the *opposite* of this principle, not a lighter version of it.
2. **Bootstrap only toward decreasing change-rate** (the safety constraint). An
   outer, fast-changing ring may bootstrap onto an inner, slower-changing one —
   UI onto `kungfu`, `kungfu` onto libkungfu — never the reverse. "One move used many
   times" has a dual: *one broken move breaks many things.* The chain is only
   safe because the things everyone depends on are the things that change least
   (the longfist layout as true invariant, [ADR-0008](ADR-0008-longfist-schema-evolution-and-minor-maintenance.md)).
   Bootstrapping the core onto a fast-changing surface pumps fragility *into* the
   core.
3. **The core sits on the maintainer's daily critical path** (protects step 2,
   inward). If a core regression does not stop the maintainer's own work — e.g.
   the core is only exercised in a CI corner nobody runs — the self-punishment
   link is broken and upkeep reverts to discipline. "The first thing that dies is
   your own hands" is a checkable hard condition, not an attitude.
4. **The demonstrated whole is the real stack, not a mock** (protects step 3,
   outward). A "demo mode" that runs against a stub re-introduces the very
   fakeability this principle exists to eliminate.

## Violation / replacement criteria

Any change to a ring or to the adoption surface that fails any of the following
is a downgrade and must be recorded here:

1. Adds a wrapper, mock, or stub on the adoption surface that does not actually
   exercise the core (breaks boundary 1 / 4).
2. Inverts a bootstrap direction so a slower-changing inner ring depends on a
   faster-changing outer one (breaks boundary 2).
3. Moves the core off the maintainer's daily critical path, so a regression no
   longer stalls the project's own build / UI / tooling (breaks boundary 3).

## Reversibility / cost

This ADR names a structure already in place; adopting it as an explicit
principle has no migration cost. Its ongoing cost is a review obligation: new
rings, demos, and onboarding paths must be checked for *load-bearingness*, since
the failure mode (a beautiful wrapper that does not exercise the core) is
exactly what an unguarded "just add a nicer demo" instinct produces.

## Lineage

- **Self-hosting compilers** — stage-0 builds the compiler with an external
  toolchain, after which the compiler compiles itself; a broken core cannot
  rebuild anything. The kungfu/kfx toolchain handoff is the same shape.
- **Dogfooding** as an industry practice — but stated here as a *forcing
  function and a trust-removal*, not merely "use your own product".
- **Eat-your-own-output validation** — deterministic replay re-consuming the
  journal is the same idea LMAX-style and event-sourced systems use: the
  recorded stream is both the product and the fixture that proves the runtime
  faithful.
