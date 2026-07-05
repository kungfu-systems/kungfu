# ADR-0017: dual-host kfx loading — a host-agnostic load plan and the background service facet on the OS-sandbox plane

- Status: proposed
- Date: 2026-07-05
- Category: (architecture) contract + topology — how each host loads a kfx, and
  the facet forms a kfx can take
- Subsystem: kfx contract — `framework/kfx` (the load plan and facet
  declarations); the two hosts — `framework/gui` (renderer loader, Chromium
  isolation) and the TUI reached through `kungfu cockpit` (Ink on libnode);
  `framework/api/src/capability` (the capability host/guest protocol and the OS
  sandbox launcher).
- Related: ADR-0011 pinned the capability SDK contract and the runtime-tier
  declaration. ADR-0013 put a trust boundary on the runtime plane — trust by
  verifiable origin, a default-deny OS sandbox, a trusted channel for zero-copy.
  ADR-0014 pinned the *uniform capability surface* so one facet source runs
  unchanged in either tier, and recorded that the OS-sandbox machinery is
  "defined but unassembled" — the primitives exist with no production caller.
  This ADR pins *who assembles them*: the same load rule serves two hosts, and a
  third facet form — a background service — is the first production caller of the
  OS sandbox.

## Context

Three facts about the system as it stands pull toward a decision.

1. **Only one host actually loads a kfx, and the load rule is fused to it.**
   `loadKfx` (`framework/gui/src/renderer/src/kfx-loader.ts`) is the sole
   production consumer of the loading path — its callers are the GUI renderer and
   `main.tsx`. It does three separable things in one pass: it *discovers*
   packages (scan extension roots, read manifests), it *decides* trust and tier
   (`authorizeFirstParty` + `resolveRuntimeTier`, both already living in
   `@kungfu-tech/kfx`), and it *lands* the view (evaluate the bundle in this
   renderer, or hand a sandboxed view to `main` for a Chromium `WebContentsView`).
   The discovery and decision steps are host-agnostic in substance, but they are
   welded to the renderer: `window.require`, `document.head` CSS injection, a
   `View` component as the return value. The TUI (`kungfu cockpit`) loads no kfx
   at all.

2. **The runtime-plane sandbox is still unassembled** (ADR-0014). The OS-sandbox
   launcher (`osSandboxCommand` — Seatbelt via `sandbox-exec` on macOS, `bwrap`
   on Linux, the native AppContainer launcher on Windows), the stdio capability
   transport, and per-runtime guests exist as verified primitives. The kfx
   guest-harness exercises them across all three platforms. But no production
   host composes them into a running sandboxed child; the only assembled sandbox
   is the GUI view plane's Chromium isolation.

3. **A kfx can only be a view or a trace adapter today, and neither is a
   long-lived process.** The two declared facets are `config.view` (a GUI screen
   the shell renders) and `config.adapter` (a *capture-side* trace instrument the
   trace supervisor injects into a traced child — not a standalone process). But
   Kungfu is a multi-process runtime, and the natural home for a pure-Python or
   pure-C++ extension is a **background process** that runs as its own long-lived
   participant and talks to the host only over the capability relay. There is no
   facet form for that, and it is exactly the shape the OS sandbox exists to
   confine.

The cockpit clarifies what "two hosts" costs. `kungfu cockpit` is a Python CLI
command, but it only shells out — it starts the Ink TUI on Kungfu's embedded Node
runtime (libnode). So **both hosts decide in a Node/TS environment**: the GUI
renderer and the TUI are both places where `@kungfu-tech/kfx` can be imported
directly. The load *rule* need not cross a language boundary. Only the loaded kfx
body may be Python or C++ — as a guest, not as the decider.

If nothing changes, the CLI never gains extension loading without duplicating the
renderer's fused logic; a background Python/C++ kfx has no contract to declare
itself and no host to launch it; and the OS-sandbox primitives keep their ADR-0014
status of "defined but unassembled" indefinitely.

## Decision

**One host-agnostic load plan, decided once and shared; landing chosen by each
host; a new background-service facet as the first OS-sandbox caller.**

1. **Split `loadKfx` into `planKfx` (host-agnostic) and per-host landing.**
   `planKfx` performs discovery + decision and returns a neutral **load plan** —
   one entry per kfx carrying `{ key, facet, tier, entry/bundlePath,
   capabilities, verdict, … }` — and *instantiates nothing*: no `View`, no DOM, no
   Electron. Filesystem access is injected (`{ fs, path, crypto }`), so the GUI
   passes its `window.require` handles and the CLI passes `node:` modules. This is
   a cut along a seam that already exists — the current `KfxEntry` is
   approximately *plan + `View`*; removing `View` yields the plan.

2. **The decision is unchanged and stays in `@kungfu-tech/kfx`.**
   `authorizeFirstParty` (frozen first-party set membership + content pin) and
   `resolveRuntimeTier` (untrusted → sandboxed; the manifest cannot elevate) are
   already host-agnostic pure functions. `planKfx` composes them; both hosts import
   the same rule. **Trusted is admitted; untrusted is confined — identically for
   the GUI and the CLI.** Which sandbox it is confined *to* is the host's choice.

3. **Add a third facet: `config.service` — a background-process kfx.** Unlike a
   `view` (a rendered screen) or an `adapter` (an instrument injected into
   *another* process), a service is a kfx's *own* long-lived process in the
   multi-process runtime, reaching the host only over the capability relay. It
   ships source per runtime and declares which runtimes it supports — following
   the shape `adapter` already established (`runtimes`, per-runtime `entry`,
   `capabilities`), extended to include **C++** alongside Python and Node.

4. **Landing is host-and-facet specific; the capability protocol is shared.**
   The plan says *whether* to confine; the host decides *how*:

   | facet × tier | GUI host | CLI host |
   |---|---|---|
   | view · trusted | mounted in the shared renderer | mounted in the TUI |
   | view · sandboxed | Chromium isolated `WebContentsView` | (renderer-bound; see open questions) |
   | service · trusted | in-process / co-resident child | co-resident child |
   | **service · sandboxed** | **OS-level sandbox process** | **OS-level sandbox process** |

   The capability *host/guest* protocol (`framework/api/src/capability`,
   `createCapabilityHost`/`Guest`) is one contract under both landings; only the
   transport differs — IPC for the Chromium plane, stdio for the OS-sandbox
   plane. This is what lets "the same rule" extend past the decision into the
   capability surface itself.

5. **Placement follows the seam.** Host-agnostic and stateless → `@kungfu-tech/kfx`:
   `planKfx`, the facet declarations (`view`, `adapter`, `service`), the decision
   functions. The capability host/guest protocol stays in
   `@kungfu-tech/api/capability` (Node and Python guest ends exist;
   `kungfu/capability/guest.py` is the Python end; a C++ guest end is new work).
   Stateful, host-specific landing stays in each host: Chromium in the GUI, OS
   sandbox + stdio relay in the CLI.

## Topology

The user-facing companion — the mental model a kfx author needs (the three facet
forms, the two hosts, discover → plan → land, and the confinement matrix) — is
[`docs/kfx-topology.md`](../../../../docs/kfx-topology.md). This ADR is the *why*;
that page is the *use*.

## Scope of the first delivery

Assembled today (reused, not invented): the decision functions in kfx; the
capability host/guest protocol; the OS-sandbox primitives verified across
macOS/Linux/Windows by the guest-harness; the Node and Python guest ends; the
`adapter` multi-runtime shape as a template.

New work this ADR authorizes: extract `planKfx` (with injected `fs`) and split
`View` off `KfxEntry`; teach the CLI/TUI host to consume a plan and land it; add
the `config.service` facet declaration; make `launchSandboxedGuest` a production
caller for `service · sandboxed`; add the C++ guest capability end and runtime.

## Explicitly out of scope

- **Native-izing the macOS/Linux sandbox into libkungfu.** The OS sandbox stays
  host-side and declarative (`sandbox-exec` / `bwrap`); Windows is native only
  because AppContainer has no CLI wrapper (see ADR-0013/0014). Landing is
  per-host; the mechanism is not unified into native.
- **A CLI command surface.** Subcommands/arguments for a CLI that launches kfx
  are a separate concern from the load plan; not pinned here.
- **Read-scope narrowing** (Landlock / macOS profile read rules) — an ADR-0014
  follow-up, orthogonal to this one.

## Residual risk

- **A sandboxed view in the CLI has no renderer.** The GUI confines a view in a
  Chromium `WebContentsView`; the TUI has no equivalent. A sandboxed *view* on
  the CLI is unresolved (see open questions); a sandboxed *service* is well-defined
  (OS sandbox) on both hosts.
- **Two landing paths can drift.** IPC and stdio transports under one protocol
  must stay contract-tested against the same capability suite, or "the same rule"
  erodes below the decision line.
- **The service facet widens the attack surface** it must confine: a long-lived
  process is a larger target than a screen. Default-deny (ADR-0013) and the
  content-pinned first-party verdict remain the load-bearing guarantees.

## Alternatives considered

- **Duplicate the load rule per host.** Rejected: both hosts are Node/TS, so a
  second copy buys nothing and invites drift on the exact code path — trust and
  tier — where drift is most dangerous.
- **Native-ize mac/Linux sandbox to match Windows.** Rejected: Windows is native
  under duress (no AppContainer CLI); mac/Linux have `sandbox-exec`/`bwrap` as
  stable system tools. Native-izing them replaces ~35 lines of declarative host
  code with fragile per-OS native code and, on Linux, collides with unprivileged
  userns restrictions that `bwrap` exists to navigate. Reversal cost is high; the
  welded-surface test — change a substrate only when it reduces user friction and
  maintainer burden — argues against it both ways.
- **Put the CLI/service contract inside kfx as stateful host code.** Rejected:
  kfx stays host-agnostic — the plan and the facet declarations, never the
  Chromium or OS-sandbox landing. Hosts consume kfx; they do not deposit their
  runtime into it.

## Open questions

- **Service facet naming and fields.** `config.service` is the proposed name,
  shaped after `adapter` (`runtimes` incl. `cpp`, per-runtime `entry`,
  `capabilities`). To be confirmed before the contract freezes.
- **Sandboxed view on the CLI.** Whether the TUI ever needs to confine a *view*
  (vs. only services), and if so what its isolation primitive is.
- **C++ guest capability end.** The shape of the native guest that speaks the
  capability relay from a sandboxed C++ service.
