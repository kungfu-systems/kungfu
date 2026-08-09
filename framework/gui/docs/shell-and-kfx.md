---
metadata_schema: kungfu.document-metadata/v1
document_status: active
period: 2026-07-27
theme: gui-shell-kfx-contract
doc_type: architecture
sources: [local-files, architecture-decisions, user-consensus]
confidence: high
sensitivity: public
evidence_grade: B
review_state: self-reviewed
last_reviewed: 2026-07-28
ai_provenance: GPT-5 via Codex on 2026-07-28; based on checked-in Kungfu contracts, implementations, tests, and the accepted KFX authority decision; no unobserved runtime state is claimed
---

# The shell and its kfx

The reference app splits into a thin shell and installable kfx view packages.
The shell owns system-level concerns only; every user-facing view — including
the ones the app ships with — is a package under `extensions/`, independently
developed, built, verified and distributed. This page is the internal
contract note for that GUI split. For the broader package topology — runtime
facets, source-authority trust, the OS-sandbox plane, and the proposed service
facet — see [`../../../docs/architecture/kfx-topology.md`](../../../docs/architecture/kfx-topology.md).
The kfx contract is deliberately NOT a published API yet: it grows from real
consumers (the shipped packages are the first ones), and it is kept
externalizable so publishing it later is a move, not a rewrite.

## What the shell owns

1. **Extension scanning and lifecycle.** The shell scans the extension roots
   for packages whose manifest declares a view, mounts their bundles, and
   keeps a per-kfx error boundary — a failing kfx renders its error panel and
   a broken install still boots to an explanation; the shell itself ships no
   views.
2. **Capability injection by declaration.** A view declares the capability
   handles it needs in its manifest; the shell hands it exactly those. This
   is the seam for a permission and audit surface over third-party kfx.
3. **Shell state.** Focused Profile, disabled kfx/suites and settings persist
   as one ConfigStore entry in the runtime home — journal-backed facts, so the
   CLI and agent APIs read and write the same configuration the GUI shows.
4. **Navigation.** The focused Profile supplies the Home screen. The primary
   Activity Rail adds Agent Console, Profiles and Skills; application menus,
   the command palette, `KFE_INITIAL_VIEW`, and cross-kfx navigation with
   parameters (`shell.open('rewind', { run })`) reach the wider installed set.
5. **Refresh coordination.** A shared refresh bus with one timer; kfx
   subscribe instead of running their own intervals.
6. **Profiles and suites.** A Profile Suite declares semantic/distribution
   closure and may project a focused Home. Focus is not activation; a suite
   still groups related kfx for distribution and operation (see below).

## A view extension is a package

```
extensions/work-dashboard/
├── package.json          # npm transport, scripts and dependencies
├── kungfu.kfx.json       # canonical KFX identity + manifest
└── src/view/index.tsx    # exports exactly one thing: the View component
```

The static half lives in the manifest — managers and installers read it
without executing code:

```json
{
  "schema": "kungfu.kfx.manifest/v1",
  "name": "@kungfu-tech/kfx-work-dashboard",
  "version": "4.0.0-alpha.4",
  "kungfuConfig": {
    "key": "work-dashboard",
    "name": "Work dashboard",
    "product": {
      "roles": ["profile-view"],
      "icon": "🧭",
      "order": 10
    },
    "config": {
      "view": {
        "title": "Work Control",
        "capabilities": ["ledger", "work"],
        "settings": []
      }
    }
  }
}
```

`product.roles` is the declarative composition seam. `profile-view`,
`agent-console`, and `system-management` project into the Activity Rail and
View menu; `tool` and `devtool` project into their respective menus.
`boot-critical` keeps a recovery surface available when disable state is
applied, but grants no capabilities and cannot elevate an untrusted package's
runtime tier. `icon` and `order` are presentation hints shared by the renderer
and Electron main-process menu projection. Replacing a Console, Manager, or
DevTool therefore changes package declarations, not Shell source.

`kungfu sdk kfx build` bundles `src/view/` to `dist/view/index.js` (CommonJS) with
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
   workspace `extensions/` tree, so shipped views load from source builds; in a
   packaged artifact it defaults to `Resources/extensions`, the product-bundled
   KFX assembly;
2. `<home>/extensions` next to the runtime dir — the install root that
   `kungfu kfx install` populates.

Scanning goes two levels deep, so suite members nested under a suite
directory (`extensions/system/<member>`) are found in the workspace layout.

## Suites

A suite groups related kfx for distribution and operation: enable/disable as a
unit and lockstep versioning. Membership is
expressed through npm `dependencies`; the manifest names the member keys for
the shell:

```json
{
  "schema": "kungfu.kfx.manifest/v1",
  "name": "@kungfu-tech/kfx-system",
  "version": "4.0.0-alpha.4",
  "kungfuConfig": {
    "key": "system",
    "suite": {
      "title": "System",
      "members": ["settings", "kfx-manager", "system-status"]
    }
  }
}
```

The System Suite (`extensions/system/`) is the first consumer: Settings, the
KFX manager, and Status are ordinary view packages. Product roles such as
`boot-critical` may keep a recovery surface visible, but they do not grant
capabilities, change admission, or select a runtime tier. Parts of a composite
module do not wire to each other —
they share journal facts; a suite carries identity and versioning, never RPC
topology. The word *bundle* is reserved for the self-describing trace/export
package (see `docs/guides/rewind.md`) and must not be used for kfx groups.

## Focused Profile experience

A `kungfu.profile-suite/v1` document owns the domain-semantic member closure.
It may additionally declare an optional product-shell projection:

```json
"experience": { "homeView": "work-dashboard" }
```

`homeView` must name a required or optional member. The Shell discovers this
declaration through the host-neutral KFX plan and uses it only for GUI focus;
it does not activate, deactivate, qualify, or grant capabilities to the
Profile. A custom Profile therefore supplies its own first screen without a
Kungfu rebuild or a Shell edit. If that view is absent or disabled, the Shell
opens Profiles visibly instead of rendering a blank screen.

Product assembly can recommend the first focused Profile by setting
`KFE_DEFAULT_PROFILE` to a discovered Profile id. A persisted valid focus wins;
an absent recommendation falls back to discovery order, while a stale persisted
id opens Profile Manager. The Shell never assigns domain meaning to the id.

Work Control uses this public path. Its Home plus the fixed Agent Console,
Profiles and Skills entries form the primary Activity Rail. Facts live under
Tools; Runtime Status, Config Store, Journal Inspector and Rewind Inspector
live under Developer. Every accessible view remains available to the command
palette, status commands, and deep links.

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
contract in [`../../../docs/architecture/extensions.md`](../../../docs/architecture/extensions.md);
`extensions/langchain-adapter` is the first adapter facet.

## Shell chrome

The GUI shell owns the application chrome around the active view. A view can ask
for chrome changes through the typed `Shell` object from `@kungfu-tech/kfx`, but
it never receives a DOM slot or an arbitrary callback injection point.

Persistent status goes through:

```ts
shell.statusBar.set({
  id: 'my-kfx.sync',
  text: 'sync ready',
  side: 'left',
  severity: 'ok',
  command: { kind: 'open-kfx', kfxId: 'my-kfx' },
});
shell.statusBar.clear('my-kfx.sync');
```

Transient user-facing messages go through:

```ts
const id = shell.notify({
  level: 'info',
  title: 'Import complete',
  message: '42 records updated',
  timeoutMs: 6000,
});
shell.dismissNotification(id);
```

Commands are declarative and shell-interpreted (`open-kfx`, `open-settings`,
`dismiss-notification`). That keeps system chrome under shell ownership while
giving every exactly authorized KFX the same notification surface. Sandboxed
views currently receive inert shell-chrome methods because the sandbox bridge
only relays declared capabilities; a future shell bridge must be explicit IPC,
not shared renderer callbacks.

## Identity-neutral runtime tiers

Discovery roots such as `Resources/extensions`, `KF_EXTENSION_PATH`, and
`<home>/extensions` find packages only. Product assembly, names, namespaces,
fixed identifiers, KFD compliance, and manifest self-labels grant no
capabilities and select no tier.

The loader defaults to the isolated Chromium plane
(`nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`) and refuses
ambient network access. It may enter the shared renderer only when Core supplies
the exact `integrated-explicit` host authorization bound to the current
Passport, policy, Work/Warrant, capability grant, Fact cut, and generation
roots. `resolveRuntimeTier` consumes that authorization; it does not infer one.
An undeclared or ungranted capability is rejected by the host relay.

The `adapter` facet runs inside the traced program and therefore cannot be
contained by a renderer sandbox. It is injected only with an exact
adapter-runtime authorization; otherwise it is refused before side effects.
Independent runtime code belongs on the OS-isolated service plane described in
`kfx-topology.md`.

## Evolution notes
- The manifest is a welded surface the moment packages are published. Until
  then it may evolve freely, but every field addition should come with a
  consumer in this repository.
