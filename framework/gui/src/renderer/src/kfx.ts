// Minimal kfx shape for the reference app's built-in extensions (v2).
//
// This is deliberately an internal module, not a published contract: the
// platform's loose kfx contract (mount points + capability handles +
// contribution declarations) is grown from real consumers — the built-in
// kfx, including the shell's own system views, are those consumers. The
// shape mirrors the intended contract so that externalizing it later is a
// move, not a rewrite. See docs/shell-and-kfx.md for the shell/kfx split.
import type {
  DomainState,
  Ledger,
  Rewind,
  Work,
} from '@kungfu-tech/api/capability';
import type React from 'react';

// Capability handles the host can hand to a kfx view (ADR-0011). A kfx never
// reaches for globals; everything it may touch comes through this object,
// and the shell only populates the handles the manifest declares — touching
// an undeclared handle is a bug the per-kfx error boundary contains.
export type KfxCapabilities = {
  ledger: Ledger;
  domain: DomainState;
  rewind: Rewind;
  work: Work;
};

export type KfxCapabilityKey = keyof KfxCapabilities;

// A settings entry a kfx contributes to the shell's Settings view. Values
// are strings; the shell persists them in the runtime home's ConfigStore so
// CLI and agent APIs read the same configuration the GUI shows.
export type KfxSettingDecl = {
  key: string;
  label: string;
  fallback: string;
};

export type ShellState = {
  profileId: string;
  disabledKfx: string[];
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

// Shell services handed to every kfx beside its capability subset.
export type Shell = {
  // cross-kfx navigation with parameters; params reach the target view
  open: (kfxId: string, params?: Record<string, string>) => void;
  // the params this view was last opened with
  params: Record<string, string>;
  // shared refresh bus (one shell-owned timer); returns the unsubscribe
  onRefresh: (fn: () => void) => () => void;
  // read a settings value (kfx-declared or shell-owned), fallback applied
  setting: (key: string) => string;
  // persist shell state changes (profile switch, kfx enable/disable,
  // settings edits); the shell owns the ConfigStore write
  updateState: (patch: Partial<ShellState>) => void;
  state: ShellState;
  // runtime facts for system views (versions, exports, home, boot message)
  info: ShellRuntimeInfo;
};

export type KfxManifest = {
  id: string;
  title: string;
  // ADR-0011: a kfx that wants in-process zero-copy runtime data must
  // declare it runs in the node-integrated context. A future serialized-IPC
  // tier would use a different value and never share this renderer.
  runtime: 'node-integrated';
  // capability handles this kfx receives; undeclared handles stay absent
  capabilities: KfxCapabilityKey[];
  // shell-owned views (settings, kfx manager, system status); not disableable
  system?: boolean;
  // settings this kfx contributes to the shell Settings view
  settings?: KfxSettingDecl[];
  View: React.ComponentType<{ caps: KfxCapabilities; shell: Shell }>;
};

// A profile bundles kfx, a default first view and vocabulary labels. It is a
// selection, not a schema: opinionated workflows arrive as profiles without
// touching the shell. System kfx are always available regardless of profile.
export type ProfileManifest = {
  id: string;
  title: string;
  kfx: string[];
  defaultView: string;
};
