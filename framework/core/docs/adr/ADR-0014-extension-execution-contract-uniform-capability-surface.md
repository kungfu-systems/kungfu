# ADR-0014: the extension execution contract — a uniform capability surface across trust tiers

- Status: proposed
- Date: 2026-07-04
- Category: (architecture) contract — the developer-facing execution surface for
  runtime extensions
- Subsystem: kfx extension contract and capability SDK — `framework/kfx`
  (`resolveRuntimeTier`), `framework/api/src/capability` (the capability proxy
  and the child-process transport), and the guest host that runs a facet.
- Related: ADR-0011 pinned the tier declaration and the zero-copy-vs-serialized
  split for the GUI view plane. ADR-0013 extended the trust boundary to the
  runtime plane — trust by verifiable origin, an OS sandbox for the default
  tier, a trusted channel for zero-copy. This ADR pins how an extension
  *addresses* that boundary: the API surface it is written against, so one
  source runs unchanged in either tier and a later restriction does not force it
  to be rewritten.

## Context

ADR-0013 gave the runtime plane a trust boundary. A source-verified first-party
facet reaches the journal in-process and zero-copy; an untrusted facet runs in
an OS-sandboxed child and reaches only its declared capabilities over the
capability relay. Two properties of the capability surface, as it stands, are
left unpinned, and they pull against each other:

1. **The surface an extension codes against differs by tier.** A node-integrated
   facet holds its capability handles synchronously against an in-process
   binding. A sandboxed facet addresses a Promise surface: every call is
   asynchronous across the relay boundary, an IPC hop that cannot be
   synchronous. The same capability method is a different shape depending on the
   tier a facet is granted.

2. **The default-tier machinery is defined but unassembled.** The OS-sandbox
   child launcher, the child-process capability transport, and a per-runtime
   guest proxy exist as primitives, but no production host composes them into a
   running sandboxed child. The only assembled sandbox today is the GUI view
   plane; the runtime-plane primitives have no caller.

If the surface stays tier-dependent, an extension author writes against the tier
a facet happens to be granted, and two costs follow. The author must fork the
code — a synchronous trusted variant and an asynchronous sandboxed variant — or
support only one tier. And any later tightening that moves a facet from the
trusted tier into the sandbox re-shapes its surface from under it, forcing every
affected extension to be re-adapted. As the contract grows facet forms, this
divergence compounds across the ecosystem. The point of an extension contract is
that an author writes against one runtime API; a tier-dependent surface breaks
exactly that.

## Decision

Pin the execution contract on three properties. Together they let an extension
be written once against the full runtime API and run unchanged in either trust
tier, with restriction added later as a transparent narrowing rather than an API
removal.

1. **One capability surface, uniform across tiers.** An extension addresses a
   single asynchronous capability surface — the same method set, the same
   Promise shape — whether it is granted the trusted tier or the sandbox. The
   trusted tier no longer offers a divergent synchronous shortcut; its calls
   resolve immediately over an in-process channel, but the surface the author
   writes against is identical. An extension never branches on which tier it is
   running in.

2. **The trusted tier keeps zero-copy under the uniform surface.** Uniformity is
   a property of the surface, not of the transport. When a facet is trusted and
   co-resident, the capability channel is an in-process call that resolves
   immediately and returns journal handles by reference — the zero-copy trusted
   channel of ADR-0013, unchanged. When it is sandboxed, the same channel is
   carried over the child-process relay and returns serialized copies. The
   performance split ADR-0013 cut along the trust axis is preserved; only the
   surface is unified.

3. **Restriction is transparent interception, never API removal.** Every
   confinement the platform adds is expressed as a redirect or a narrowing of
   what a capability reaches, never as the withdrawal of a capability. A
   restricted facet still calls the same method; what changes is the view it is
   served — a narrower filesystem projection, a redirected mapping backed by a
   shadow the platform reconciles, a resource ceiling enforced by the OS. An
   extension written correctly against the full surface therefore keeps running
   when a restriction is later turned on: it observes a narrower result, not a
   missing method. This is the property that makes confinement additive rather
   than a breaking change.

A single binding-less guest host realizes this contract. It composes the
OS-sandbox launcher, the child-process capability transport, and the per-runtime
guest proxy into one host that presents the uniform surface to every extension
runtime, with the trust tier selecting the channel underneath — an in-process
short-circuit for the trusted tier, an OS-sandboxed child for the default tier.
The guest never holds the native binding directly; it addresses only the
capability surface. This is the production host the ADR-0013 primitives were
built for.

## Scope of the first delivery

The welded surface above is the contract. The first implementation deliberately
ships it with confinement turned off: the default tier runs under a permissive
profile — able to run, not yet restricted — so the contract and the host are
proven before any restriction is layered on. The delivery target is the uniform
surface running real extensions across the interpreted facet forms (a JavaScript
facet and a Python facet) on the supported platforms (macOS arm64 and Linux),
with no restriction applied. Native-compiled forms are addressed by the
feasibility map below rather than in this first delivery.

## Restriction feasibility — confinement is additive

Each restriction the platform may later add is recorded here with the
transparent mechanism that adds it, so the contract's central promise — that a
correctly-written extension is not re-adapted when confinement is turned on — is
demonstrable rather than asserted:

| Restriction | Transparent mechanism (redirect, not removal) | Status |
|---|---|---|
| Deny network | sandbox network denial (network namespace / profile rule) | verified on hardware |
| Deny filesystem writes | read-only bind / profile write denial | verified on hardware |
| Narrow reads | Landlock read rules (Linux) / profile read rules (macOS) / container defaults (Windows) | feasible, not built |
| Redirect a mapping to a shadow | bind the real path to a shadow the platform reconciles to the journal | feasible, not built |
| Descriptor hygiene | spawn close-on-exec, stdio-only channel | largely already |
| Resource ceilings | cgroups / job object / task limit | feasible, not built |

Network and filesystem-write denial are demonstrated on real hardware; the
remainder are confirmed feasible at the design level and marked as not yet
built. Each is a narrowing of what a capability reaches, so an extension written
against the full surface keeps running when it is enabled. The shadow redirect
holds only under a single-writer discipline — the guest writes the shadow and
the platform reconciles it one way to the journal — which the implementation
must preserve.

## Explicitly out of scope

- The confinement profiles beyond the permissive default, the
  shadow-reconciliation layer, narrowed reads, and resource ceilings. The
  feasibility map records that these are addable transparently; building them is
  a follow-up.
- Native-compiled extension forms — carried in the feasibility map, not the
  first delivery.
- A Windows sandbox profile — consistent with ADR-0013, the first cut targets
  macOS (arm64) and Linux.

## Residual risk

- The uniform surface makes the trusted tier asynchronous where it was
  synchronous; a hot zero-copy path now wraps its handle in an
  immediately-resolved promise. This is the deliberate price of a non-forking
  surface, recorded so it reads as a chosen trade, not an oversight.
- A redirected mapping is consistent only under the single-writer discipline
  above; the implementation must hold that invariant or the shadow and the
  journal diverge.
- All of ADR-0013's residual risk stands. Transparent interception does not
  change that an OS sandbox is a best-practice ceiling, not absolute safety;
  that the capability surface remains the real trust boundary and must be
  audited as one — a method that does something dangerous with
  caller-controlled arguments re-widens what a sandbox narrows.
- The Linux default tier currently confines via user, pid and network
  namespaces and a read-only bind; the narrowed reads named in the feasibility
  map require adding Landlock. The boundary should be described as what is
  implemented, not as the fuller set.

## Alternatives considered

- **Keep the trusted tier synchronous and let the surface differ by tier.**
  Rejected: it forces an extension to fork by tier or support only one, and it
  makes any later move of a facet into the sandbox a breaking re-adaptation —
  the divergence this ADR exists to close.
- **Express restriction by withdrawing capabilities.** Rejected: withdrawing a
  method breaks a correctly-written extension the moment a restriction is
  enabled, which is the re-adaptation cost the transparent-interception rule
  removes. A narrowed result keeps the contract; a missing method breaks it.
- **A separate host per extension runtime.** Rejected: it re-introduces the
  per-plane transport duplication the binding-less host removes, and it is where
  a tier-dependent surface creeps back in.

## Next (implementation, follow-up)

1. Assemble the binding-less guest host from the existing OS-sandbox launcher,
   child-process transport, and guest proxy; add the missing Node child-side
   guest proxy.
2. Present the uniform asynchronous capability surface across tiers, with the
   trusted tier short-circuiting in-process and returning handles by reference
   to keep zero-copy.
3. Author the permissive default-tier profile and run the interpreted forms on
   macOS and Linux with no restriction, proving the contract before confinement
   is layered on.
