# KFX topology: identity-neutral admission and confinement

This page explains how a KFX moves from inert package bytes to an authorized
runtime. It complements [`extensions.md`](extensions.md), which explains how to
author a package. The machine authority is
[`kungfu-kfx.contract.json`](../../framework/kfx/kungfu-kfx.contract.json) and its
Core implementation under `framework/core/src/libkungfu/src/runtime/kfx/`.

## One authorization equation

A KFX may execute only when Core can reconstruct all of:

```text
exact Release Passport
+ Core policy
+ admitted Work and issued Warrant
+ exact capability declaration and grant
+ host-specific runtime isolation
= one rooted runtime authorization
```

Every term is necessary. A KFD assessment establishes conformance and
eligibility only; it is not an authorization. A package name, namespace,
signature made by the package itself, discovery root, installer origin,
bundling state, Product System role, or fixed identifier contributes zero
authority. The same exact evidence produces the same admission and confinement
outcome for product-bundled and externally installed packages.

Product System metadata is deliberately inert. It may describe assembly,
distribution, default installation, update routing, navigation, icons, ordering,
and recovery presentation. It cannot change admission grade, approval friction,
runtime tier, placement, host access, confinement, or capability grants.

## Facets and physical hosts

A package declares one or more facets under `kungfuConfig.config`:

| Facet | Physical form | Required host authorization |
| --- | --- | --- |
| `view` | GUI renderer or TUI presentation | exact view authorization plus granted capabilities |
| `adapter` | code injected into a traced child | exact adapter-runtime authorization; otherwise refused |
| `service` | independent Python, Node, or C++ process | exact service authorization and process isolation |

Facet declarations express requested behavior; they do not authorize it. An
adapter cannot be safely sandboxed after injection, so missing or mismatched
authorization refuses before injection. A service uses the OS-isolated process
plane. A view uses an isolated Chromium plane unless an exact
`integrated-explicit` authorization allows co-residency.

GUI, TUI, CLI, and Agent are projections of one Core descriptor. They preserve
the same `registryRoot`, `graphRoot`, `planRoot`, `cutRoot`, revision,
`generationRoot`, capability roots, Warrant root, and authorization root. A
presentation host may report that a facet is dormant or unavailable; it may not
recompute or widen authority.

## Discover, inspect, assess, admit, launch

1. **Discover.** Core scans only explicit roots and parses canonical
   `kungfu.kfx.json` manifests. `package.json` and Product System declarations
   remain distribution inputs. Scanning produces candidates, never authority.
2. **Inspect.** Core computes the package closure and exact package and manifest
   roots. A package cannot add authority by declaring labels such as `system`,
   `firstParty`, `productSystem`, `trusted`, or `supportsKFD`; such request
   claims are refused.
3. **Assess.** Core verifies the exact Release Passport and the existing KFD
   assessment contract. The result is an eligibility/trust report, not
   permission to execute.
4. **Plan.** Core combines the report with Core policy, requested policy,
   admitted Work, Warrant, capability declaration, explicit grant, target host,
   and placement. Missing, replayed, sibling, stale, or post-plan-mutated roots
   fail closed.
5. **Admit.** A Fact cut binds the graph, plan, report, policy, Warrant, grant,
   placement, and generation roots. Mutation authorization is recomputed before
   side effects.
6. **Launch.** The physical host accepts only its exact
   `kungfu.kfx.host-authorization/v2` root from the admitted descriptor. No
   descriptor, preview-only state, root mismatch, or stale generation means no
   execution.

`planKfx` in the TypeScript package is an inert preview projection. It can help
render diagnostics, but it cannot independently admit or launch a package.
Registry history JSONL, scan results, package metadata, and process-local
generation counters are likewise projections or inputs, never final authority.

## Runtime tiers and capability relay

The identity-neutral runtime tiers are:

- `isolated`: sandboxed renderer or OS process, no ambient filesystem or
  network authority, and only explicitly granted relay capabilities;
- `integrated-explicit`: co-residency allowed only by an exact rooted
  authorization; identity and origin do not select this tier;
- `metadata-only`: presentation and distribution metadata with no execution.

Capabilities cross a narrow host relay. The KFX declares what it needs, Core
policy decides what may be requested, an explicit grant records the allowed
subset, and the host exposes only that subset. Undeclared or ungranted calls are
rejected. Isolation still applies when a package is KFD-compliant.

## Control Suite and minimal TCB

The KFX Control Suite follows the same public contract as every other KFX. It
does not gain authority from being shipped with Kungfu. Its production active
path requires the same exact Passport, KFD eligibility, policy, Work/Warrant,
grant, Fact cut, generation, and host authorization chain.

Only a minimal Core-owned recovery TCB exists:

- contract parsing and canonical rooting;
- one native registry writer per runtime directory;
- Fact/Work/Warrant verification before side effects;
- last-known-good selection bound to exact roots;
- safe-mode diagnostics with execution disabled;
- owner- and threshold-governed emergency recovery.

The TCB is enumerated by the native contract and tested as refusal-first
behavior. Safe mode does not implicitly activate the Control Suite.

For developer recovery and debugging, Core also provides one deliberately
separate source-bootstrap route. It may install only the checked-out
`extensions/system/kfx-manager` into the `.kungfu/runtime` of an explicitly
named local workspace that shares the same Git common directory. It grants
exactly `kfxControl`, requires the ordinary plan/apply CAS sequence, and is
never a Release Passport or Warrant substitute: publication, shared
installation, external capabilities, updates, removal, and cross-repository
targets are refused. The resulting receipt is labelled
`development-source-bootstrap`, so it cannot be confused with production
admission evidence.

## Author obligations

- Declare every facet and its least required capability set explicitly.
- Expect the package to run isolated unless an exact authorization says
  otherwise.
- Treat KFD success as eligibility evidence, not permission.
- Do not branch behavior on bundled paths, package namespaces, Product System
  roles, or fixed package names.
- Preserve exact receipt and generation roots across GUI, TUI, CLI, and Agent
  projections.

## See also

- [`extensions.md`](extensions.md)
- [KFX native registry and authority contract](../../framework/kfx/kungfu-kfx.contract.json)
- [KFX identity-neutral terminal qualification](../qualification/kfx-identity-neutral-terminal.md)
- [KFX authority decision](../adr/KF-ADR-019f86da-4f90-7afa-a1e1-0510f00916be.md)
- [KFX trust boundary](../adr/KF-ADR-019f86da-4f90-79f1-8716-aca36b142847.md)
- [Uniform capability surface](../adr/KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9.md)


## npm module boundaries inside a checkout

Workspace placement does not grant access to another package's implementation.
A KFX, API, or reference host declares each consumed package and uses its public
`exports`. Build entrypoints and tests follow the same rule. Source aliases and
relative paths into sibling packages are rejected by the repository boundary
check. See [framework package consumption](../../framework/README.md).

An npm export controls module visibility. It grants no runtime capability,
admission, activation, or Warrant authority; those still follow the authorization
equation above.
