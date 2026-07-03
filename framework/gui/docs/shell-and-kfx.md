# The shell and its kfx

The reference app splits into a thin shell and installable kfx view packages.
The shell owns system-level concerns only; every user-facing view — including
the ones the app ships with — is a package under `extensions/`, independently
developed, built, verified and distributed. This page is the internal
contract note for that split. The kfx contract is deliberately NOT a
published API yet: it grows from real consumers (the shipped packages are the
first ones), and it is kept externalizable so publishing it later is a move,
not a rewrite.

## What the shell owns

1. **Extension scanning and lifecycle.** The shell scans the extension roots
   for packages whose manifest declares a view, mounts their bundles, and
   keeps a per-kfx error boundary — a failing kfx renders its error panel and
   a broken install still boots to an explanation; the shell itself ships no
   views.
2. **Capability injection by declaration.** A view declares the capability
   handles it needs in its manifest; the shell hands it exactly those. This
   is the seam for a permission and audit surface over third-party kfx.
3. **Shell state.** Profile, disabled kfx/suites and settings persist as one
   ConfigStore entry in the runtime home — journal-backed facts, so the CLI
   and agent APIs read and write the same configuration the GUI shows.
4. **Navigation.** View switching, the `KFE_INITIAL_VIEW` deep link, and
   cross-kfx navigation with parameters (`shell.open('rewind', { run })`).
5. **Refresh coordination.** A shared refresh bus with one timer; kfx
   subscribe instead of running their own intervals.
6. **Profiles and suites.** A profile selects kfx and the first screen; a
   suite groups related kfx for distribution and operation (see below).

## A view extension is a package

```
extensions/work-dashboard/
├── package.json          # identity + manifest (kungfuConfig)
└── src/view/index.tsx    # exports exactly one thing: the View component
```

The static half lives in the manifest — managers and installers read it
without executing code:

```json
"kungfuConfig": {
  "key": "work-dashboard",
  "name": "Work dashboard",
  "config": {
    "view": {
      "title": "Work dashboard",
      "capabilities": ["ledger", "work"],
      "system": false,
      "settings": []
    }
  }
}
```

`kfs kfx build` bundles `src/view/` to `dist/view/index.js` (CommonJS) with
`react`, `react/jsx-runtime`, `react-dom` and `@kungfu-tech/api` left
external; the shell injects its own instances through a require shim at load
time, so every kfx shares one React and one capability surface. The
`@kungfu-tech/kfx` package (contract types + UI tokens) is bundled in — it is
types and plain objects, never stateful.

`npm pack` of a built package is its distribution unit: one tgz installs
offline into any home via `kungfu kfx install <tgz>` (extracted to
`<home>/extensions/<key>`), and `kungfu kfx list` / `remove` manage it —
the CLI and the kfx-manager view operate on the same facts.

## Extension roots

The loader scans, in priority order (first occurrence of a key wins):

1. `KF_EXTENSION_PATH` entries — in development this defaults to the
   workspace `extensions/` tree, so shipped views load from source builds;
2. `<home>/extensions` next to the runtime dir — the install root that
   `kungfu kfx install` populates.

Scanning goes two levels deep, so suite members nested under a suite
directory (`extensions/system/<member>`) are found in the workspace layout.

## Suites

A suite groups related kfx for distribution and operation: navigation
grouping, enable/disable as a unit, lockstep versioning. Membership is
expressed through npm `dependencies`; the manifest names the member keys for
the shell:

```json
"kungfuConfig": {
  "key": "system",
  "suite": { "title": "System", "members": ["settings", "kfx-manager", "system-status"] }
}
```

The System Suite (`extensions/system/`) is the first consumer: Settings, the
kfx manager and Status are ordinary view packages marked `system: true`
(always available, never disableable), shipped through the same contract as
everything else. Parts of a composite module do not wire to each other —
they share journal facts; a suite carries identity and versioning, never RPC
topology. The word *bundle* is reserved for the self-describing trace/export
package (see `docs/rewind.md`) and must not be used for kfx groups.

## Profiles (v1)

A profile is a selection, not a schema: it names the kfx set and the default
first view. The default profile ships the work dashboard first; nothing in
the shell depends on any workflow methodology — an opinionated workflow
arrives as another profile without touching the shell. User-defined event
schemas and generic core concepts stay out of v1 deliberately.

## Runtime facets: the shell is not the only loader

A kfx facet is declared under `kungfuConfig.config`; a package may carry more
than one, and each facet has its own loader. The shell loads the `view` facet.
The `adapter` facet — capture-side framework instrumentation, the first v4
runtime facet — is loaded by the **trace supervisor**, not the shell: it scans
the same extension roots, finds packages declaring an adapter for a child
runtime, and injects the adapter source into the traced child, where the
dependency-free capture hook loads it. So "installable kfx package" spans both
planes — a GUI view and a capture-side adapter share one package model,
manifest, extension root and install lifecycle, but different loaders. Full
contract in [`../../../docs/extensions.md`](../../../docs/extensions.md);
`extensions/langchain-adapter` is the first adapter facet.

## Trust tiers (ADR-0011)

A view runs at one of two tiers; `resolveRuntimeTier` (`../../kfx/src/index.ts`)
is the single source and the install source is authoritative (a manifest may
ask to stay sandboxed, never to elevate). **node-integrated** (system + built-in
views) shares the shell's renderer, React and capabilities. **sandboxed-ipc**
(installed third-party views) runs in an isolated renderer
(`nodeIntegration:false, contextIsolation:true, sandbox:true`) with no node;
`contextBridge` exposes only a bridge to the declared capabilities, each call
round-trips to the trusted host over IPC (`sandbox-host.ts`), and an undeclared
capability is rejected there — the declaration is an enforced boundary. The
view's session denies the network and its process is memory-capped
(`createSandboxedView`). Proven live: in a real sandboxed renderer
`window.require`/`process`/`Buffer` are absent, a declared call round-trips, an
undeclared call is rejected. The `adapter` facet stays node-integrated (it runs
inside the traced program's own process; its schema compilation is bounded
separately).

## Evolution notes
- The manifest is a welded surface the moment packages are published. Until
  then it may evolve freely, but every field addition should come with a
  consumer in this repository.
