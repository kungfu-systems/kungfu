# kfx topology — how a kfx is loaded, trusted, confined, and connected

This page is the mental model behind [`extensions.md`](extensions.md). That page
tells you *how to write, build and install* a kfx; this one tells you *what
happens to it* once a host finds it — which host loads it, how the host decides
whether to trust it, which sandbox it lands in if it isn't trusted, and how it
talks back. The design rationale is [ADR-0017](../framework/core/docs/adr/ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md)
(with [ADR-0013](../framework/core/docs/adr/ADR-0013-cli-runtime-extension-isolation-trusted-channel.md)
for the trust boundary and [ADR-0014](../framework/core/docs/adr/ADR-0014-extension-execution-contract-uniform-capability-surface.md)
for the uniform capability surface).

> Status: draft — the load plan and the `service` facet are proposed
> (ADR-0017); `view` loading is implemented in the GUI today. Where a claim is
> ahead of the code, it is marked *(proposed)*.

## The one rule

**Trusted kfx are admitted; untrusted kfx are confined — by the same rule, on
every host.** A host never trusts a kfx because of *where it was found on disk*.
It trusts it because its identity is a member of the frozen first-party set and,
if that entry is content-pinned, the bundle's hash matches. Everything else is
untrusted by default and runs in a sandbox. The manifest cannot ask for more
trust than its origin earns.

Which *sandbox* an untrusted kfx lands in is the host's business, not the kfx's.
The kfx author writes one thing; the host decides where it runs.

## Three forms a kfx can take (facets)

A kfx package declares one or more **facets** under `kungfuConfig.config`. A
facet is *what the package does*; a host's loader picks up only the facets it
understands.

| facet | what it is | runs as | runtimes |
|---|---|---|---|
| **view** | a GUI screen the host renders | UI in the host's render surface | JS |
| **adapter** | capture-side trace instrumentation | injected into a *traced* child (the trace supervisor loads it) | Python, Node |
| **service** *(proposed)* | the kfx's *own* long-lived background process | a participant in Kungfu's multi-process runtime, talking to the host over the capability relay | Python, Node, **C++** |

The distinction that matters for topology: a **view** is rendered, an **adapter**
is a hook that lives inside someone else's process, and a **service** is a
process of its own. Kungfu is a multi-process runtime, so a pure-Python or
pure-C++ kfx is naturally a **service** — and a service is exactly what the
OS-level sandbox exists to confine.

## Two hosts, one decider

A kfx can be loaded from either host:

- **GUI** — the Electron shell; views render in Chromium.
- **CLI** — reached through `kungfu cockpit`, which starts the Ink TUI on
  Kungfu's embedded Node runtime (libnode).

`kungfu cockpit` is a Python command, but it only launches the TUI — the TUI
itself is Node/TS. So **both hosts decide in the same Node/TS environment** and
import the *same* load rule from `@kungfu-tech/kfx`. There is no second copy of
"is this trusted, which tier" to keep in sync. Only the *loaded* kfx may be
Python or C++ — as a guest process, never as the thing making the trust decision.

## The lifecycle: discover → plan → land

```
                 @kungfu-tech/kfx  (host-agnostic, one rule)
                 ┌───────────────────────────────────────────┐
   extension     │  discover      →   decide      →  plan     │
   roots  ─────► │  scan roots,       authorizeFirstParty     │
   (manifests)   │  read manifests    resolveRuntimeTier      │
                 │                    (trusted? which tier?)   │
                 └──────────────────────────┬────────────────┘
                                            │  load plan
                        one neutral entry per kfx:
                    { key, facet, tier, entry, capabilities }
                     (instantiates nothing — no View, no DOM,
                      no process yet)
                                            │
                 ┌──────────────────────────┴─────────────────────────┐
                 ▼                                                     ▼
        GUI host lands it                                     CLI host lands it
        (Chromium plane)                                      (OS-sandbox plane)
```

1. **Discover** — the host scans its extension roots and reads each package's
   `kungfuConfig` manifest. Roots are a dev override (`KF_EXTENSION_PATH`) and the
   install root next to the runtime.
2. **Plan** *(proposed: `planKfx`)* — the shared rule computes, per kfx, a neutral
   **load plan**: its key, facet, resolved **tier** (trusted → admitted;
   untrusted → sandboxed), entry, and declared capabilities. The plan
   *instantiates nothing* — it decides, it does not run.
3. **Land** — each host takes the plan and runs it its own way. The plan says
   *whether* to confine; the host chooses *how*.

## Where an untrusted kfx lands (the confinement matrix)

| facet · tier | GUI host | CLI host |
|---|---|---|
| view · trusted | mounted in the shared renderer | mounted in the TUI |
| view · sandboxed | Chromium isolated `WebContentsView` | *(open — the TUI has no renderer)* |
| service · trusted | in-process / co-resident child | co-resident child |
| **service · sandboxed** | **OS-level sandbox process** | **OS-level sandbox process** |

The **OS-level sandbox** is the platform's process-grade confinement:

- **macOS** — a Seatbelt profile via `sandbox-exec`.
- **Linux** — a bubblewrap (`bwrap`) namespace + bind mount; if `bwrap` is
  absent the launch is *refused*, never run unconfined.
- **Windows** — a native AppContainer applied by the libkungfu launcher.

Chromium isolation confines a **JS view**; the OS sandbox confines a **process**
(a Python/C++/Node service). That is why a pure-Python or pure-C++ background kfx
needs the OS sandbox specifically — a renderer can't hold a process.

## How a confined kfx talks back (the capability relay)

A sandboxed kfx has no ambient authority — it cannot reach the filesystem, the
network, or the journal directly. It reaches **only the capabilities its manifest
declares**, and only over the **capability relay**. The relay is one protocol
(`createCapabilityHost` / `createCapabilityGuest`) under both sandboxes; only the
transport differs:

- **Chromium plane (GUI view)** — capability calls hop over **IPC** to a trusted
  capability host that holds the real handles.
- **OS-sandbox plane (service)** — capability calls travel over the child's
  **stdio** relay to the host.

Because the surface is uniform (ADR-0014), the *same* kfx source addresses its
capabilities the same way whether it is trusted or sandboxed; turning on a
restriction narrows what a capability returns (a refused write, a refused socket)
— it never removes a method the code calls.

## What this means for you, the kfx author

- You declare a **facet** (`view`, `adapter`, or `service`) and the
  **capabilities** you need. You do not choose your sandbox — the host does, from
  your trust tier.
- If your kfx isn't in the frozen first-party set, assume it runs **sandboxed**,
  reaching only its declared capabilities over the relay. Write against that
  surface and it also runs unchanged when trusted.
- A **service** kfx (proposed) is how you ship a pure-Python or pure-C++
  background extension: it runs as its own process in the multi-process runtime,
  confined by the OS sandbox when untrusted, and speaks to the host over the
  capability relay. Python and Node ship *source* (an interpreter loads it); a
  **C++ service ships a prebuilt per-platform binary** — `entry.cpp` is a
  `{ darwin?, linux?, win? }` map to the binary you cross-compiled against the
  guest proxy (`framework/core/src/capability/guest.hpp`), because there is no
  interpreter to compile it at launch.

## See also

- [`extensions.md`](extensions.md) — writing, building, installing a kfx (the
  *how-to*).
- [ADR-0017](../framework/core/docs/adr/ADR-0017-dual-host-kfx-loading-host-agnostic-plan-and-service-facet.md)
  — the design decision behind dual-host loading and the service facet.
- [ADR-0013](../framework/core/docs/adr/ADR-0013-cli-runtime-extension-isolation-trusted-channel.md),
  [ADR-0014](../framework/core/docs/adr/ADR-0014-extension-execution-contract-uniform-capability-surface.md)
  — the trust boundary and the uniform capability surface this builds on.
