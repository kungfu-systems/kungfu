# ADR-0046: Rust host trunk, layered CLI, and the assembled runtime distribution

- Status: accepted (target architecture; adoption is staged — see "Adoption
  path". Stage boundaries that carry their own decisions get their own ADRs.)
- Date: 2026-07-10
- Category: architecture — process host topology, CLI layering law, runtime
  distribution contract
- Subsystem: whole product — the process host, the CLI, runtime distribution
  and package management, the `engage` bridges, the freeze chain
- Related: [`docs/rust-host-spike.md`](../../../../docs/rust-host-spike.md)
  (the measured feasibility and cost evidence this decision stands on);
  [`docs/rust-adoption.md`](../../../../docs/rust-adoption.md) (this ADR is
  the argued case that consumption mode 2 — cdylib/FFI embedding — demands);
  [ADR-0009](ADR-0009-load-bearing-self-bootstrap.md) (the trunk becomes the
  outermost load-bearing ring at runtime, as the launcher is at build time);
  [ADR-0044](ADR-0044-shifu-delegation-protocol.md) (stage-0 toolchain
  delegation; the trunk is its runtime sibling);
  [ADR-0045](ADR-0045-kfx-execution-profiles-native-rust-wasm.md) (extension
  execution profiles; both ADRs draw on the same Rust line, at different
  layers: 0045 places extensions, this ADR places the host).

## Question

Who owns `main()`, who parses the command line, and what Python/Node runtime
does the product ship? Today all three answers are welded to one choice: the
runtime binary is a Nuitka-frozen Python entrypoint, so Python owns the
process, click owns every argument, and the shipped Python is a compiled
subset that cannot host arbitrary packages. This ADR decides the target shape
for all three, from first principles rather than from the current form.

## Drivers

1. **The front door must not depend on the heaviest satellite.** With a
   Python-owned entrypoint, `kungfu --help` cannot answer without a healthy
   interpreter, and the commands most needed when the Python environment is
   broken — doctor, env repair, service control — share their failure domain
   with the thing they diagnose. Control-plane commands also pay interpreter
   startup on every invocation, which an agent- and script-heavy usage profile
   multiplies.
2. **Exact-runtime support contract.** Users must run kungfu's own pinned
   Python runtime, and every package they install must resolve against that
   exact interpreter — otherwise support degenerates into "help me debug my
   Python". The runtime the product ships must therefore be *complete*
   (a real CPython with a real site-packages), not a frozen subset.
3. **Full package ecosystem inside the blessed runtime.** PyTorch-class
   packages are freezer-hostile by construction (dynamic loading, plugin
   registration, pruned-stdlib landmines). A frozen host can never offer
   "pip anything into kungfu's runtime"; an assembled one gets it for free.
4. **Measured, not argued.** The host-shell spike (`crates/host-spike`,
   [`docs/rust-host-spike.md`](../../../../docs/rust-host-spike.md)) proved
   the full fabric — libkungfu core init, embedded python-build-standalone,
   pykungfu, real journal traffic with cross-language readback, libnode
   started and returning control — runs under a Rust `main()` today. The same
   spike measured that freezing is no longer slow or large; what freezing
   costs is an incident class (runtime-only surprises), a hand-maintained
   exclusion surface, dev/prod divergence, and the loss of the complete
   runtime that drivers 2 and 3 require.

## Decision

### 1. A Rust host trunk owns `main()`

The product's entry binary is a Rust program (the trunk). It owns process
lifecycle, runtime bootstrap, environment and package management, service
supervision, diagnostics, and physical-layer inspection through the libkungfu
FFI seam. Python and Node are satellites the trunk starts on demand; a
command path that does not need a runtime never initializes it.

### 2. Layered CLI — whoever implements the semantics parses the arguments

The trunk parses the root: global flags, routing, and every command that must
work when Python is broken. Each satellite parses its own subtree: a
Python-domain command's arguments are defined where its semantics live, in
Python; likewise for Node. Arguments are parsed exactly once, by the layer
that implements them. Unified `--help` renders from a declarative command
manifest so the trunk never wakes a satellite to print usage. The trunk is
argv-transparent for domain subtrees: beyond routing (and variant dispatch)
it does not interpret, swallow, or inject arguments — the domain layer is the
single source of truth for its own surface. Mirroring a domain command's
argument surface into the trunk is the failure mode this law exists to
prevent: every flag would acquire two truths that drift.

### 3. Layer-placement criteria (standing law)

Three sequential criteria; the first that applies decides:

1. **Availability class** — must it work when the Python environment is
   broken or absent? Then it belongs to the trunk.
2. **Churn coupling** — does it change with platforms, toolchains, and the
   process model (→ trunk), or with the product's evolving understanding of
   the domain — how events are interpreted, timelines reconstructed, reports
   shaped (→ the matching satellite)?
3. **User surface** — implement a layer in the language its users consume and
   extend it in, so the product's own implementation continuously validates
   the user path (the runtime instance of
   [ADR-0009](ADR-0009-load-bearing-self-bootstrap.md)).

Placement in Python must hold one of three tickets: it is a user extension
surface (kfx / strategy / analysis code is written in Python), it is
domain-semantics-heavy (its output's *meaning* evolves with product
understanding), or it genuinely needs the Python ecosystem. The default is
the trunk — drift historically flows toward "conveniently written in Python",
never the reverse, so the burden of proof sits on the Python side.

Two structural rules complete the law:

- **Python owns no resident processes.** Analysis commands are per-invocation
  satellites; anything long-lived (services, supervision loops) is trunk.
  This retires the GIL/signal/graceful-exit class of host assumptions
  structurally instead of patching it.
- **Every Python CLI command is a thin wrapper over an importable API.** The
  CLI is the API's first consumer, never the only interface.

The resulting allocation:

| layer | owns | examples |
|---|---|---|
| C++ core | the bytes | journal/storage semantics, mmap fabric, integrity |
| Rust trunk | the machine | env/package management (uv, pnpm orchestration), doctor, config/contract, self-update, service lifecycle and supervision, managed runs, journal/storage physical inspection via FFI |
| Python domain | the meaning | rewind, trace, work/report, agent/skill context, engage, the py-kfx execution contract, the `import kungfu` API |
| Node domain | the presentation and the JS ecosystem | TUI/cockpit, sdk/kfx build, GUI side, the js-kfx execution contract |

`journal` is deliberately split by this law: whether a frame's bytes are
valid is trunk; what a session's activity *means* is Python. The test:
if the output's meaning changes as product understanding evolves, it is
domain.

### 4. Assembled runtime distribution — the freezer retires at end state

The product ships a **complete, exact CPython** (python-build-standalone —
the same distribution uv pins for the build — bundled at a pinned
version+build) instead of a frozen subset, plus **uv as the bundled install
engine**. The runtime-exclusivity contract has three mechanisms:

- **kungfu owns the install surface**: packages are installed through kungfu
  commands (uv underneath), and environments derive only from the bundled
  interpreter — a wheel only ever resolves against the exact blessed triple.
- **Wrong-runtime guard**: the kungfu Python package verifies at startup that
  it is running on the blessed interpreter (buildinfo / `sys.prefix` check)
  and fails with a named, self-diagnosing error otherwise — wrong-runtime
  becomes a crisp message instead of a mystery support case.
- **One interpreter lifecycle per process**: the embedded CPython initializes
  lazily, at most once, and is never finalized-and-restarted (CPython
  re-initialization is not reliable, and libkungfu's process-level state is
  initialize-once). A second Python lifetime is a new satellite process; the
  journal mmap fabric is the communication plane, so heavy-package workloads
  (PyTorch-class) run in satellite processes at full zero-copy.

On the Node side symmetrically: libnode stays the only Node runtime (no
second node binary, no fnm at runtime), and JS package management runs
*on* libnode (pnpm/corepack are JS programs) with installs keyed to
libnode's exact node version. Environments carry a `node` shim that
re-enters the kungfu binary in its node variant, so npm lifecycle scripts
work without a system node. Native addons are supported as prebuilt binaries
resolved against the pinned `NODE_MODULE_VERSION`; compile-on-install is an
explicit developer scenario, not part of the zero-install promise.

### 5. Embedding contract

The trunk consumes the **single shared libkungfu image** — one copy of the
core's process-level state (frame dumper, kv provider, sqlite, bus) per
process, never a second statically-embedded yijinjing. The dylib grows an
explicit exported embedding surface (the spike found `journal::assemble`
absent from the export set); which symbols constitute that surface is decided
when stage 3 lands, recorded against this ADR.

## Alternatives considered

- **Frozen host + uv-managed satellite runtimes.** Bundle uv and a pinned
  satellite CPython next to the frozen binary; heavy packages run in
  satellites over the journal. This genuinely delivers drivers 2 and 3 with
  the smallest change, and is acknowledged as a legitimate *interim* — but as
  an end state it permanently ships two Python runtime semantics (pruned
  frozen host + complete satellite), keeps the freezer's exclusion-list
  maintenance and dev/prod divergence forever, and leaves the front door
  welded to Python. Rejected as target, viable as a stage.
- **Thin exec launcher instead of a trunk.** A minimal binary that execs the
  assembled `python -m kungfu` for everything. Simpler than embedding — and
  argv0/self-exec assumptions get *simpler* — but the front door remains
  Python-bound for every command, so driver 1 (diagnostic independence,
  ms-class control plane) is unmet. Rejected as end state; its insight (the
  assembled interpreter is a real `sys.executable`) survives in stage 2.
- **Full CLI in Rust (mirror the domain commands).** clap is fully capable of
  it; rejected because domain commands' semantics live in Python — mirroring
  their argument surfaces into the trunk creates two sources of truth with
  permanent sync cost. The layering law (decision 2) is the recorded
  boundary.
- **Rewrite the core or the domain layer in Rust.** Out of scope and against
  standing boundaries: the memory-safety core stays C++, hot paths never
  cross an FFI seam, and domain code stays in the language users extend
  ([`docs/rust-adoption.md`](../../../../docs/rust-adoption.md)).

## Adoption path (each stage independently shippable)

1. **Stage 1 — package capability on the current form.** Bundle uv, pin the
   satellite CPython, publish a pykungfu wheel for it, land the
   kungfu-owned install surface and the wrong-runtime guard. The frozen host
   is untouched; users get "pip anything into kungfu's exact runtime" via
   satellite environments.
2. **Stage 2 — assembly replaces freezing.** The host itself runs the
   assembled tree (stdlib pruning policy decided here, in its own record);
   freeze leaves the product path platform by platform (macOS → Linux →
   Windows); verify gates move off the freeze step.
3. **Stage 3 — the Rust trunk takes `main()`.** Trunk commands migrate per
   the placement criteria; variant dispatch moves to the trunk (a node-only
   invocation never initializes Python); the embedding export surface lands.

Stages 2 and 3 briefly coexist as dual host forms; that window is bounded and
each stage ships alone. If later evidence stalls the line between stages, the
completed stages stand on their own value and this ADR's remaining stages are
re-decided rather than silently assumed.

## Consequences

- The runtime the user extends is the runtime the product runs — one
  interpreter family, pinned, complete; "which Python" ceases to exist as a
  support category, by mechanism rather than by policy.
- The Nuitka incident class (runtime-only freeze surprises), the
  `nofollow-import` exclusion surface, and dev/prod freeze divergence retire
  with stage 2 — as does the freezer's strongest property, physical
  impossibility of running a foreign interpreter, which the wrong-runtime
  guard replaces with a detected, named failure.
- The `engage` bridges shrink: per-kfx Python dependencies become uv-managed
  environments (the pdm bridge retires), and the nuitka bridge retires with
  the freezer.
- The trunk adds a Rust component on the product path (not just tooling) —
  release, CI, and the crates/ workspace carry it under the existing
  discipline; dist size grows by the uv binary and the full stdlib, partially
  offset by dropping the frozen binary.

## Violation criteria

Record against this ADR any change that:

1. adds a trunk-parsed argument to a domain command, or mirrors a domain
   command's argument surface into the trunk (breaks the layering law);
2. introduces a second Python interpreter family or a second Node runtime
   into the product (breaks the exclusivity contract);
3. makes any Python-owned process resident (breaks the no-resident-Python
   rule);
4. links a private copy of the core into any host component (breaks the
   single-image rule);
5. lets a package install path bypass the kungfu-owned surface silently
   (weakens the support contract — if a bypass is ever wanted, it must be
   explicit and named).
