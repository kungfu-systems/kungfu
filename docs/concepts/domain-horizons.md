# Domain horizons for the runtime-fact core

Kungfu's current product focus is accountable agent runtime. Its native core is
kept domain-neutral because the same runtime-fact structure has one historical
proof domain and one credible future derivative domain.

This is an architecture horizon map, not three simultaneous product roadmaps.
It exists to prevent a current feature from narrowing the core in ways that
would later require a second fact substrate.

## The three horizons

| Horizon | Status | What it proves or pressures |
| --- | --- | --- |
| quantitative trading engines | historical proof | low-latency journal, multi-process ordering, replay, polyglot in-process membrane, long-lived operation |
| accountable agent runtime | current focus | heterogeneous actions, long Episodes, evidence, cost/state/proof, historical query, recovery, handoff and human-agent operation |
| games and virtual worlds | future derivative | fixed/logical ticks, input and AI events, checkpoints, state reconstruction, replay, timeline UI, fault reproduction and portable world history |

Virtual reality belongs to the games/virtual-world horizon at the fact layer.
Kungfu does not aim to become a renderer, physics engine, headset runtime, or
large-3D asset pipeline. It can provide the semantic timeline beneath those
systems.

## Shared core

The common substrate is intentionally small:

```text
ordered append-only facts
+ declared causality
+ Episode lifecycle and identity
+ payload and schema commitments
+ current and historical cuts
+ fold, query, diff and pattern semantics
+ verification, export and portability
```

These objects do not name a trading order, an agent prompt, or a game entity.

## Domain profiles

Domain meaning enters above the core:

| Domain | Profile and adapter examples |
| --- | --- |
| trading | quote/order/trade/account schemas; exchange adapters; trading state projections |
| agent runtime | model/tool/action/cost/evidence schemas; provider adapters; responsibility projections |
| games/virtual worlds | input/rule/world-change/checkpoint/asset-version schemas; engine adapters; replay and timeline projections |

Profiles may be first-party and highly optimized. They remain consumers of the
same core contracts rather than reasons to fork the kernel.

## Day 1 preparation rules

Every proposed core feature is checked against the three horizons:

1. Express the mechanism in domain-neutral runtime-fact language.
2. Keep domain fields in extensible schemas, profiles, or adapters.
3. Do not make one domain's clock the universal time model. Trading event time,
   agent knowledge time, and game simulation ticks must fit declared time axes
   and cuts.
4. Do not make one domain's object lifecycle the only Episode shape.
5. Preserve a native embedded path and language-neutral artifact format.
6. State which horizon supplies current evidence and which horizons are only
   compatibility witnesses.

This is not a requirement to implement speculative adapters. It is a
requirement not to weld avoidable domain assumptions into the core.

## Quantitative trading: historical proof

Kungfu's trading history demonstrates that the underlying mechanisms can carry
real pressure: sustained processes, high event rates, multiple locations,
ordered journals, replay, and C++/Python/Node integration.

The trading domain remains evidence and a supported profile lineage. It is not
the vocabulary owner of the v4 runtime-fact kernel. Concepts such as category,
exchange, order, or account stay outside neutral location, fact, Episode, and
query contracts.

## Agent runtime: current focus

Agent work is the current product wedge and dogfood source. It pressures the
core with long-running heterogeneous work, partial completion, external side
effects, responsibility, evidence, cost, recovery, and human/agent dual-first
operation.

Current prioritization remains simple:

```text
build and qualify the agent-runtime product
-> learn from real use
-> promote only reusable mechanisms into the core
```

The core must not permanently rename generic facts, Episodes, cuts, or payloads
around today's model/provider vocabulary.

## Games and virtual worlds: future derivative

Games expose a closely related need that is currently fragmented across save
files, engine replay systems, input traces, rollback netcode, analytics, and
custom debugging tools.

A future Kungfu engine adapter could record semantic inputs, AI decisions,
rule outcomes, authoritative state changes, random seeds/results, checkpoints,
and build/asset commitments into Episodes. The query and changelog services
could drive replay, timeline animation, historical inspection, and fault
reproduction. Rendering frames remain derived output and normally should not be
the authoritative event stream.

This horizon becomes active only after a bounded validation proposal exists.
Until then it serves as a design witness: new core work should not make a
low-friction Unity, Unreal, Godot, Electron, or other native adapter
architecturally impossible.

## Promotion rule

A domain mechanism enters the core only when:

- its neutral invariant is clear;
- at least the current domain provides real evidence;
- it does not impose another domain's vocabulary or dependency closure;
- its schema, format, query, and compatibility costs are accepted;
- lower layer qualifications continue to pass.

Otherwise it remains a domain profile, KFX, SDK helper, engine adapter, or
reference application.

## Roadmap discipline

- **Now:** complete the agent-runtime truth source, query, CLI, and human
  surfaces through real dogfood.
- **Always:** retain and rerun quantitative-trading compatibility evidence where
  it protects kernel invariants.
- **Prepare, do not expand:** keep games/virtual worlds representable and the
  adapter boundary open; do not start a parallel product line without an
  explicit validation gate.

The purpose of the third horizon is not to increase active scope. It is to make
domain capture visible before it becomes irreversible.
