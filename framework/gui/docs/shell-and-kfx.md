# The shell and its kfx

The reference app splits into a thin shell and pluggable kfx views. The shell
owns system-level concerns only; every user-facing feature — including the
ones the app ships with — is a kfx. This page is the internal contract note
for that split. The kfx contract is deliberately NOT a published API yet: it
grows from real consumers (the built-in kfx are the first ones), and it is
kept externalizable so publishing it later is a move, not a rewrite.

## What the shell owns

1. **Kfx registry and lifecycle.** Manifests, enable/disable (persisted),
   the default first view, and a per-kfx error boundary — a failing kfx
   renders its error panel, it never takes the shell down.
2. **Capability injection by declaration.** A kfx declares the capability
   handles it needs (`ledger`, `domain`, `rewind`, `work`, ...); the shell
   hands it exactly those. This keeps the door open for a permission and
   audit surface once external kfx exist.
3. **Settings.** The shell renders settings; the values live in the runtime
   home's domain ConfigStore — journal-backed facts, so the CLI and agent
   APIs read and write the same configuration the GUI shows. Each kfx may
   contribute its own settings namespace through its manifest.
4. **System status.** Master liveness, runtime home, versions, journal store
   overview. The future storage health story (fsck/export) mounts here.
5. **Navigation.** View switching, the `KFE_INITIAL_VIEW` deep link, and
   cross-kfx navigation with parameters (`shell.open('rewind', { runId })`),
   so one kfx can hand the user to another kfx's detail view.
6. **Refresh coordination.** A shared refresh bus with one timer; kfx
   subscribe instead of running their own intervals.
7. **Profiles.** A profile bundles kfx, a default view and vocabulary labels
   (see below).
8. **UI tokens.** The shared dark/dense/monospace style objects. No component
   library, by design.

Everything else is a kfx. The shell never contains domain logic — it does not
know what a work item, a run or a config entry means.

## System kfx

Settings, the kfx manager and system status are themselves kfx, marked
`system: true` (they cannot be disabled). Shipping the shell's own features
through the same contract keeps the contract honest — the first consumers of
every manifest field are in this repository.

## Manifest (v2)

```ts
type KfxManifest = {
  id: string;
  title: string;
  runtime: 'node-integrated';        // ADR-0011 tier declaration
  capabilities: (keyof KfxCapabilities)[]; // handles this kfx receives
  system?: boolean;                  // shell-owned, cannot be disabled
  settings?: KfxSettingDecl[];       // contributed settings namespace
  View: React.ComponentType<{ caps: Partial<KfxCapabilities>; shell: Shell }>;
};
```

`Shell` is the service surface handed to every kfx alongside its capability
subset:

```ts
type Shell = {
  open: (kfxId: string, params?: Record<string, string>) => void;
  params: Record<string, string>;    // params this view was opened with
  onRefresh: (fn: () => void) => () => void; // shared bus; returns unsubscribe
  setting: (key: string) => string | undefined;
};
```

## Profiles (v1)

A profile is a selection, not a schema: it names the kfx set, the default
first view, and vocabulary labels. The default profile ships the work
dashboard and the Rewind inspector as the working surface. Nothing in the
shell or the default profile depends on any particular workflow methodology;
an opinionated workflow (different vocabulary, different views over different
event families) arrives as another profile without touching the shell.

Deliberately out of scope for v1: user-defined event schemas and generic core
concepts (plan/job/case ...). Those belong to the core/profile evolution after
the fact layer has proven itself; freezing them now would weld vocabulary
before the substrate has earned it.

## Evolution notes

- External kfx loading and a `sandboxed-ipc` runtime tier are declared in the
  manifest shape but not implemented; the `runtime` field is the seam.
- The manifest is a welded surface the moment it is published. Until then it
  may evolve freely, but every field addition should come with a consumer in
  this repository.
