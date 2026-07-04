# ADR-0013: extension isolation and the trusted channel on the runtime plane

- Status: proposed (design accepted 2026-07-04; implementation deferred to a
  follow-up, see Next)
- Date: 2026-07-04
- Category: (architecture) contract — the trust boundary for runtime extensions
- Subsystem: kfx extension contract and capability SDK — `framework/kfx`
  (`resolveRuntimeTier`), `framework/api/src/capability` (the capability proxy),
  and the trace supervisor that loads runtime facets
- Related: ADR-0011 pinned the tier declaration and the zero-copy-vs-serialized
  split for the GUI view plane; ADR-0006 defined the node-integrated context a
  trusted extension needs. This ADR extends the tier model to the runtime plane
  and pins how trust is granted.

## Context

ADR-0011 gave the GUI **view** plane a real isolation tier: an installed
third-party view runs `sandboxed-ipc`, in an isolated renderer with no direct
binding, reaching only its declared capabilities over IPC. The **runtime**
plane has no equivalent. A capture-side `adapter` facet is loaded by the trace
supervisor and runs in-process inside the traced program; installing one is a
trust decision guarded only by an install-time prompt. As the kfx contract
grows facet forms beyond views, this plane will carry more third-party code with
no enforced boundary.

Two properties of the current tier decision motivate this ADR:

1. **Trust is derived from a filesystem path.** `resolveRuntimeTier` grants the
   trusted tier when a package loads from a built-in root and the sandboxed tier
   otherwise. "Built-in" is which extension root the loader found the package
   in — a writable location, and, for the development override, an environment
   variable. A path is not an authority.
2. **One tier conflates two independent questions.** Whether code is *trusted*
   and whether a facet's function *requires running inside another process* are
   different axes; the single tier collapses them.

## Decision

1. **Two axes, not one tier.** Resolve the tier as a function of both a **trust
   axis** (source-verified first-party vs. third-party) and a **co-residence
   axis** (instrumentation that must run inside the target process vs.
   independent compute that can be isolated). The current single tier is the
   root cause of the gaps above.

2. **Default tier: OS-level isolation, default-deny.** An untrusted
   independent-compute facet runs in an isolated child process under an OS
   sandbox — a Seatbelt profile on macOS; Landlock, seccomp-BPF and
   user/pid/net namespaces on Linux — with filesystem, network and syscalls
   denied by default. Its only egress is the capability relay: the same
   transport-agnostic capability proxy ADR-0011's sandboxed tier already uses,
   with its channel implemented over child-process IPC instead of renderer IPC.
   An undeclared capability is rejected at the host; the declaration is an
   enforced boundary, and resource limits are applied by the OS.

3. **Trusted channel: in-process, zero-copy.** A source-verified first-party
   facet reaches the journal directly — one shared journal, zero-copy,
   multi-language — exactly as a node-integrated extension does. Zero-copy and
   process isolation are opposed; the trust tier is where they are cut: trusted
   code keeps zero-copy, sandboxed code takes serialized copies through the
   relay.

4. **Instrumentation is gated, not contained.** A capture-side adapter runs
   inside the traced program's own process by construction; isolating it into a
   separate process defeats the instrumentation. An untrusted adapter is
   therefore **refused**, not sandboxed — injecting third-party code into a
   program requires the trusted channel. This is stated plainly so that
   "sandbox" is never read as a blanket safety claim covering the runtime plane.

5. **Trust is granted by verifiable origin, never by path.** Replace the
   root-derived trust with a build-time frozen first-party set — a package key
   plus a content hash baked into the distributed binary; a package is trusted
   only if its key is in the set and its content matches. The source-authority
   check is a **pluggable verdict**: frozen-set membership is its first
   implementation, and signature verification can be added as a second when a
   real trusted third-party case exists — without rewriting the tier decision.
   Independently of which authority is used, a writable extension root or an
   environment variable must never confer trust.

## Explicitly out of scope

- The implementation itself — per-platform sandbox launchers, the child-process
  transport, and a guest capability proxy per child runtime — is a follow-up.
- Signature and publisher infrastructure — deferred until a real trusted
  third-party consumer exists; not built on speculation.
- A Windows sandbox profile — this cut targets macOS (arm64) and Linux.

## Residual risk

There is no absolute security; the goal is a best-practice ceiling with the
residue recorded, so "sandboxed" is not misread as "safe":

- OS sandbox escape (kernel or sandbox-implementation defects), side channels,
  and time-of-check/time-of-use hazards on relayed capability arguments.
- macOS Seatbelt is a coarser, less officially supported boundary than the App
  Sandbox container; the guarantee is stated honestly, not as equivalence.
- The capability surface is the real trust boundary and must be audited as one:
  a capability method that does something dangerous with caller-controlled
  arguments re-widens the surface a sandbox narrows.
- A build-time frozen trusted set moves trust to the build pipeline (supply
  chain) — stronger than a runtime-writable path, but not free.
- Instrumentation adapters are gated, not contained: a user who grants trust to
  a malicious adapter gives it full in-process power over that run. The
  mitigation is authority and informed consent, not containment.

## Alternatives considered

- **MicroVM isolation (gVisor / Firecracker)** — rejected as the default:
  disproportionate for a per-extension desktop boundary, and Firecracker
  requires KVM. Retained as an optional hardened tier for high-value untrusted
  compute.
- **WASM / WASI sandboxing** — rejected as the general substrate: extensions are
  Python and Node with native modules, which WASI cannot host. It may suit a
  future pure-compute facet.
- **Keep trust path-derived and add only an install-time prompt** — rejected: a
  prompt is advice, not a boundary, and a writable path is not an authority.

## Next (implementation, follow-up)

1. Introduce the source-authority verdict interface with the frozen first-party
   set as its first implementation; stop deriving trust from the extension root.
2. Extend tier resolution from views to every facet form, as a function of trust
   and co-residence; refuse untrusted instrumentation adapters.
3. Add the OS-sandbox child launcher per platform and the child-process
   capability transport (a guest proxy per child runtime), reusing the existing
   capability proxy unchanged.
