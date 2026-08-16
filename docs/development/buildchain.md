# Buildchain — from source to binary

How source becomes the binaries you run, and where each binary comes from. This
is a *use* reference; for the day-to-day commands and prerequisites see
[`CONTRIBUTING.md`](../../CONTRIBUTING.md), and for why the release pipeline is
shaped the way it is see [`version-release-design.md`](version-release-design.md).

## Pinned bootstrap drivers

A fresh clone needs only `curl`. The orchestrator is `./shifu` (the development
entry point; see [`concepts.md`](../concepts/implementation-concepts.md)); it acquires pinned drivers into
the user-global Kungfu cache when needed:

- **Node side:** `fnm` selects the Node version pinned by `.node-version`, then
  Corepack provides the package manager (`pnpm`) at the version pinned in
  `package.json`.
- **Python side (symmetric):** `uv` manages a standalone CPython plus `uv.lock`,
  and `uv run` drives the Python build tools (Conan, Nuitka).
- **Build protocol:** Buildchain is selected by `.buildchain-version`, resolved
  pin-first from its standalone three-platform release archives, and added to
  child `PATH` when a declared package script invokes the bare `buildchain`
  command. `buildchain layout --json` is the stable KFD registry question;
  Shifu does not duplicate Buildchain's internal layout.

So the toolchain is reproducible from checked-in pins, not from whatever Node,
Python, or Buildchain happens to be on the host. `./shifu <task>` runs any `pnpm` task
under those pinned tools.

## Protected dev delivery

Kungfu consumes Buildchain's two-phase Delivery Warrant on protected dev lines.
The ordinary PR workflow first runs source acceptance and emits a semantic
affected-native descriptor without starting the costly native partitions. A
ready, approved exact head can then acquire the next provisional Warrant. Its
TTL is renewed by heartbeat while Buildchain tests a composed tree containing
that immutable source head and the current dev base.

The protected native command is
`./shifu dev-delivery:native-under-warrant`. It executes the affected closure in
both partitions plus the selected SDK, Shifu workspace, and KFD checks, writes a
rooted receipt into the Buildchain evidence artifact, and updates the existing
`affected-native / linux` required context only for the exact PR head. Native
success does not itself admit a merge: Buildchain must atomically upgrade the
fenced provisional generation to qualified, after which `Queue admission
lease` and GitHub's merge queue remain the landing authorities.

Buildchain classifies a moving dev base against the semantic source, closure,
dependency, and toolchain roots. Non-overlapping base-only movement reuses the
native proof; overlap, an unknown comparison graph, a source change, or a
conflict fails closed into bounded requalification or safe Warrant release.
Kungfu derives the semantic source root from the canonical changed-path set and
each path's final Git object, mode, and deletion state. The exact replay tree
remains delivery-bound, but it is deliberately excluded from the reusable
qualification identity so an unrelated dev commit cannot rename an otherwise
identical proof artifact before overlap classification runs.
Kungfu reconstructs that optional Native Qualification Proof only from the
exact source workflow run's `core-dev-delivery-source-proof-<head>` artifact.
The protected caller verifies its Source Proof, PR/head/base coordinate, and
all semantic roots against its independently projected Warrant input before it
passes `native-proof-json` to Buildchain. A missing legacy artifact means a
full native run; malformed or cross-head evidence cannot become reusable.
The source workflow also observes the active phase before every legacy hosted
native lane, so no normal PR event can start those expensive jobs without the
same provisional or qualified authority.

After an exact release or lease recovery, Buildchain wakes the next retained
candidate with the `buildchain-dev-delivery-wake` repository event. The complete
candidate remains nested under one `client_payload.candidate` envelope so the
GitHub repository-dispatch top-level property limit cannot discard semantic
proof bindings. Kungfu treats that payload only as a bounded wake coordinate:
it requires the protected target, exact PR, and immutable head to agree, then
resolves and verifies the matching source-acceptance run from GitHub before
calling the pinned controller. A missing or malformed wake therefore leaves
the queue fail-closed for patrol recovery; it never grants a later PR authority
to pass the active Warrant.

Every hosted native lane now uses the protected Buildchain Warrant runner in
the same process that starts the native command. It observes the exact PR,
source head, phase, generation, and fence; heartbeats before spawn and for the
full native lifetime; and terminates the process group within a bounded window
if the fence is lost. PR and merge-group matrices are serialized so concurrent
workers cannot race state-ref heartbeats. The one-time migration bootstrap was
retired after the controller reached protected dev, so no current path can
bypass the exact active Warrant.

A dequeue notification is transient while that exact native holder is still
live. It neither closes the Warrant nor promotes a waiting candidate. The same
generation and fencing token remain authoritative across heartbeats; only
authoritative merge, cancellation, failure, or supersession evidence can settle
the holder. An expired holder also remains fenced until its worker is proven
stopped and that exact generation is settled.

## Source → binary

| Output | From | Via |
|---|---|---|
| `libkungfu` (C++ core: yijinjing schema + journal) | `framework/core/src` | CMake + Conan 2; build orchestration in `framework/core/.gyp/` |
| Python binding (`py_kungfu`) | `framework/core/src/bindings/python` | pybind11, built under the pinned CPython |
| Node addon (`kungfu_node.node`) | `framework/core/src/bindings/node` | N-API via the `.gyp` build |
| `kungfu` (the product runtime) | the above + the Python/Node runtimes | `./shifu freeze` — assembles the complete pinned CPython tree next to the entry on every platform ([KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05](../adr/KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05.md) stage 2; the Nuitka/PyInstaller freeze legs were retired 2026-07-11) |
| distributable products | product runtime + GUI/TUI/CLI + all product-declared first-party kfx | `./shifu dist` |
| product loops | SDK-distributed GUI/TUI/CLI dev/build verbs | single kfx: `kungfu sdk product gui dev`; product assembly: `kungfu sdk product gui dist`; repo dogfood via `./shifu product ...` |

### node-pty platform runtime closure

The CLI product stages `node-pty` according to the machine-readable
[`node-pty-runtime-closure.contract.json`](../../product/node-pty-runtime-closure.contract.json).
For the pinned `node-pty@1.1.0`, Linux uses `forkpty` and ships only
`build/Release/pty.node`; `spawn-helper` is a Darwin-only build target. Darwin
ships the architecture-exact prebuild containing `pty.node` and an executable
`spawn-helper`, while Windows ships its architecture-exact prebuilt addon.

The contract is enforced twice: staging rejects dependency-version or file-set
drift, and the extracted product archive must actually create a child PTY via
`nodePty.spawn()`. A source-only fixture cannot authorize a different platform
closure. Changing this contract requires updating the dependency pin and
proving the resulting archive on the affected native platform before upload.

## Freeze retirement ledger (fully retired 2026-07-11)

[KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05](../adr/KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05.md) stage 2 retired freezing platform by platform, and Windows — the last
frozen platform — exited on 2026-07-11. The freeze **distribution** chain is now
gone; only the `assemble` leg ships. What was removed, and what stays and why:

| Leg | Status | Note |
|---|---|---|
| `run-freeze.js` nuitka leg + the `nuitka-project` header shim `src/python/kungfu_cli.py` (the `nofollow-import` list) | **retired 2026-07-11** — leg and shim deleted | Windows was the last frozen platform; `assemble` is the sole leg |
| `run-freeze.js` pyinstaller fallback leg + `src/python/kungfu.spec` + `src/python/pyi-hooks/` | **retired 2026-07-11** — leg, spec, and hooks deleted | retired together with the nuitka leg |
| `conanfile.py` legacy freeze path (its `freezer` option + `__run_freeze`/`__run_nuitka`/`__run_pyinstaller` + PyInstaller import) | **retired 2026-07-11** — dead code removed | freeze had left conan in the conan2 migration; the option was no longer passed by the build chain |
| `engage nuitka` / `engage pdm` bridges | **kept, deliberately** — their consumer is the Python-AOT kfx build contract (`kungfu sdk kfx build` for py extensions), not the freeze chain; retirement follows the [KF-ADR-019f86da-4f90-7d41-a4a0-e6b01d4b31c6](../adr/KF-ADR-019f86da-4f90-7d41-a4a0-e6b01d4b31c6.md) execution-profile line, not this ledger |
| Nuitka / PyInstaller pins in dev deps | **pyinstaller pin retired 2026-07-11**; **nuitka pin kept** — now resolved only by the `engage nuitka` bridge ([KF-ADR-019f86da-4f90-7d41-a4a0-e6b01d4b31c6](../adr/KF-ADR-019f86da-4f90-7d41-a4a0-e6b01d4b31c6.md)), no longer by any freeze leg |

`scripts/check-runtime-greenfield.mjs` owns the executable negative ratchet. It
permits the exact historical ledger rows above, rejects the retired runtime
signatures and product-host vocabulary everywhere active, requires
assembled-only selection and installed layout evidence, and separately pins the
KFX Nuitka AOT and Windows Job Object contracts that this retirement must not
erase.

The assembled form's own policy record is
[KF-ADR-019f86da-4f90-7ecd-9660-81f9f74dc416](../adr/KF-ADR-019f86da-4f90-7ecd-9660-81f9f74dc416.md)
(stdlib pruning); the target architecture is
[KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05](../adr/KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05.md).

## Where the prebuilt binaries come from

kungfu distributes prebuilt cross-platform binaries rather than expecting users to
compile (see [`version-release-design.md`](version-release-design.md)): the native
artifacts are published via node-pre-gyp (configuration in
[`framework/core/package.json`](../../framework/core/package.json)), and the `kungfu` runtime is
shipped as an assembled complete CPython tree ([KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05](../adr/KF-ADR-019f86da-4f90-73ff-9543-f0a4f0beef05.md) stage 2). A tag is bound
to its binaries atomically — *tag exists ⇒ the
matching binaries exist* — which is the trust property the release mechanism
exists to hold.

## CI source checkout cache

Formal Alpha and Release candidates plus the Dev Verify consumed by Candidate
Patrol use fresh GitHub-hosted runners with checkout-cache mode `off`. They fetch
the immutable source directly from GitHub and do not receive private Cargo
registry, Shifu cache-profile, Git mirror, or reference-repository inputs.
Self-hosted and explicit custom diagnostics may instead use Buildchain's locked
source checkout cache in `auto` mode. Those runners first try the trusted
local/LAN Git object cache declared by repository or organization variables,
then fall back to GitHub if the cache is unavailable:

- `BUILDCHAIN_CHECKOUT_CACHE_MIRROR_URL_TEMPLATE`
- `BUILDCHAIN_CHECKOUT_CACHE_REFERENCE_REPOSITORY_TEMPLATE`

These values are intentionally not checked into this repository or projected
into formal hosted jobs. They describe private runner or local-network topology.
Buildchain still resolves and verifies the immutable source commit and tree
before running lifecycle commands, and it writes sanitized
`source-checkout.json` diagnostics into the platform artifacts.

## Alpha and release artifact relay

Every Alpha or release candidate build transfers native platform artifacts
through Buildchain's configured S3 relay before the collector rehydrates the
exact artifacts for downstream GitHub Actions consumers. The same fail-closed
route applies to manual diagnostic Build runs: the workflow exposes no direct
GitHub artifact-transfer selector, so manually collected evidence exercises the
same relay boundary as protected promotion.

The relay changes transport, not artifact identity. Buildchain still binds the
source SHA, platform, digest, and expiry in its artifact coordinates, and the
publication workflows consume the rehydrated exact artifacts. Missing relay
roles or a failed upload/download is therefore a failed build, never permission
to fall back to an unrecorded direct transfer path.

Buildchain's `alpha` channel remains an Alpha maturity input, but Kungfu owns
its repository-specific GitHub discovery policy. During the final Alpha
publication commit Kungfu rewrites the product Release to `draft=false`,
`prerelease=false`, and `make_latest=true`; the stable publication tail
explicitly applies the same values. A following read-only check proves that
GitHub Latest and its `buildchain.release.json` download resolve to the newest
Kungfu product Publication Bundle. Component workflows explicitly use
`make_latest=false`, so Shifu or Xinfa publication cannot replace the product
discovery pointer.

### Linux x64 Core package budget preflight

Before writing the Linux x64 Core npm tarball, the packer performs a dry-run
projection with the same npm pack implementation and compressed-byte units as
the final 100 MiB hard ceiling. The projection retains a 64 KiB measurement
error bound, component-level unpacked-byte attribution, headroom, and the delta
from the last qualified Alpha artifact. A guarded projection over the ceiling
stops the product build before downstream UI and qualification work. The real
tarball is still created and checked afterward; the preflight cannot replace
the final compressed-size authority, and a final value outside either the hard
ceiling or the guarded projection fails closed.

## Maturity

The local build path (`./shifu sync && ./shifu build`) is real and is
how the repository builds itself. The **consumer-facing provenance** of a
published binary — how you verify a download's signature and that it matches its
tag — is tracked separately and waits on the release infrastructure being fully
operational on this repository; see [`known-limits.md`](../qualification/known-limits.md) and the
`provenance` row in [`MAP.md`](../MAP.md).

## Continuity claim binding

Buildchain does not decide whether a continuity benchmark is meaningful or
whether its result supports stronger copy. Kungfu qualification owns the
one-minute smoke, matched long-task comparison, public projection, and their
verdicts. Buildchain's release responsibility is narrower: when comparative
continuity copy is published, the Release Passport binds the exact release
artifact and copy to the fixture, runner and latest-native-baseline identities,
reset method, oracle, raw report, projection, limitations, and independent
review.

A smoke cannot be promoted into `FO10` evidence, and an animation without its
retained report is non-qualifying. An ordinary patch with no comparative claim
does not rerun the full comparison merely for Buildchain admission. See the
[release and promotion gate](../qualification/gates/release-and-promotion.md#continuity-claim-evidence-boundary)
and the machine contract at
`framework/agent-work/kungfu-agent-work-state.contract.json`.
