// The kfx view contract: the types a view extension implements and the shell
// consumes, plus the shared UI tokens. This package is bundled INTO each view
// extension (it is types and plain style objects — nothing stateful), while
// `react`, `react/jsx-runtime`, `react-dom` and `@kungfu-tech/api/capability`
// stay external and are injected by the shell at load time, so every kfx
// shares the shell's React instance and capability handles.
//
// Static facts about a view (title, capabilities, settings, system flag)
// live in the package manifest (`kungfuConfig.config.view`), never in code:
// managers and installers read them without executing the extension. The
// code side exports exactly one thing — the View component.
import type {
  DomainState,
  Ledger,
  Rewind,
  Work,
} from '@kungfu-tech/api/capability';
import type React from 'react';

// ── capability surface ────────────────────────────────────────────────────

export type KfxCapabilities = {
  ledger: Ledger;
  domain: DomainState;
  rewind: Rewind;
  work: Work;
};

export type KfxCapabilityKey = keyof KfxCapabilities;

// ── manifest data (package.json `kungfuConfig`) ───────────────────────────

// A settings entry a view contributes to the shell's Settings view. Values
// are strings; the shell persists them in the runtime home's ConfigStore.
export type KfxSettingDecl = {
  key: string;
  label: string;
  fallback: string;
};

// `kungfuConfig.config.view` — the static half of a view extension.
export type KfxViewDecl = {
  title: string;
  // capability handles this view receives; undeclared handles stay absent
  capabilities: KfxCapabilityKey[];
  // shell-owned views (settings, kfx manager, status); not disableable
  system?: boolean;
  // settings this view contributes to the shell Settings view
  settings?: KfxSettingDecl[];
  // bundle entry relative to the package root (default: dist/view/index.js)
  entry?: string;
};

// `kungfuConfig.config.adapter` — a runtime facet. Unlike a view (a GUI screen
// the shell loads), an adapter is capture-side instrumentation: the trace
// supervisor discovers it, and injects it into the traced child, where it
// patches a framework's seam so unmodified runs are captured. It ships source
// per child runtime (nothing to bundle), not a `dist/view` artifact.
export type KfxAdapterDecl = {
  // module import names whose import triggers the patch (informative)
  targets: string[];
  // child runtimes this adapter instruments
  runtimes: ('python' | 'node')[];
  // adapter entry per runtime, relative to the package root
  entry: { python?: string; node?: string };
  // capture-side capabilities the adapter needs; undeclared stay absent — the
  // same permission seam a view's `capabilities` is (reserved for enforcement)
  capabilities?: string[];
};

// `kungfuConfig.suite` — a suite groups related kfx for distribution and
// operation: navigation grouping, enable/disable as a unit, lockstep
// versioning. Membership is expressed through npm dependencies; `members`
// lists the kungfuConfig keys for the shell.
export type KfxSuiteDecl = {
  title: string;
  members: string[];
};

// ── runtime contract (what the shell hands a mounted view) ────────────────

export type ShellState = {
  profileId: string;
  disabledKfx: string[];
  disabledSuites: string[];
  settings: Record<string, string>;
};

export type ShellRuntimeInfo = {
  ok: boolean;
  message: string;
  runtimeDir: string;
  kfcVersion: string;
  buildInfo: Record<string, unknown> | null;
  exports: string[];
  longfistTypes: { name: string; fields: string[] }[];
};

// One loaded view as the shell sees it: manifest data joined with the code.
export type KfxEntry = {
  id: string;
  title: string;
  capabilities: KfxCapabilityKey[];
  system: boolean;
  settings: KfxSettingDecl[];
  suite?: string;
  packageName?: string;
  version?: string;
  source: 'built-in' | string; // extension root the entry was loaded from
  // resolved trust tier (resolveRuntimeTier). A node-integrated view carries a
  // loaded View mounted in the shared renderer; a sandboxed-ipc view carries
  // only its bundlePath, loaded in an isolated renderer, and View is a
  // placeholder the shell must not mount directly.
  tier: KfxRuntimeTier;
  bundlePath: string;
  View: KfxViewComponent;
};

export type Shell = {
  // cross-kfx navigation with parameters; params reach the target view
  open: (kfxId: string, params?: Record<string, string>) => void;
  // the params this view was last opened with
  params: Record<string, string>;
  // shared refresh bus (one shell-owned timer); returns the unsubscribe
  onRefresh: (fn: () => void) => () => void;
  // read a settings value (view-declared or shell-owned), fallback applied
  setting: (key: string) => string;
  // persist shell state changes; the shell owns the ConfigStore write
  updateState: (patch: Partial<ShellState>) => void;
  state: ShellState;
  // runtime facts for system views
  info: ShellRuntimeInfo;
  // every loaded kfx (for the manager and settings views)
  registry: KfxEntry[];
  // suites by key (for grouping and unit enable/disable)
  suites: Record<string, KfxSuiteDecl>;
  // available profiles (shell-defined; a profile selects kfx + first screen)
  profiles: ProfileManifest[];
};

export type KfxViewProps = { caps: KfxCapabilities; shell: Shell };
export type KfxViewComponent = React.ComponentType<KfxViewProps>;

// A view extension's bundle exports exactly this shape.
export type KfxViewModule = {
  View: KfxViewComponent;
};

// A profile bundles kfx ids, a default first view and vocabulary labels.
export type ProfileManifest = {
  id: string;
  title: string;
  kfx: string[];
  defaultView: string;
};

// ── UI tokens (dark, dense, monospace — no component library) ─────────────

export const panelStyle: React.CSSProperties = {
  background: '#252526',
  border: '1px solid #3c3c3c',
  borderRadius: 6,
  padding: 12,
  overflow: 'auto',
  minHeight: 0,
};

export const headingStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: '#858585',
  margin: '0 0 8px 0',
};

export const mono: React.CSSProperties = {
  fontFamily: 'SF Mono, Menlo, monospace',
  fontSize: 12,
};

export const inputStyle: React.CSSProperties = {
  ...mono,
  padding: 4,
  background: '#1e1e1e',
  border: '1px solid #3c3c3c',
  borderRadius: 4,
  color: '#cccccc',
};
