// Reference app shell: boots the in-process runtime and mounts kfx through
// the v2 contract. The shell owns system concerns only — kfx registry and
// lifecycle, capability injection by declaration, navigation with params,
// the shared refresh bus, shell state (profile / disabled kfx / settings,
// persisted in the runtime home's ConfigStore) and the per-kfx error
// boundary. Every user-facing feature is a kfx; the work dashboard stays
// the default first screen through the default profile. See
// docs/shell-and-kfx.md.
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { KfxCapabilities, KfxManifest, Shell, ShellState } from './kfx';
import { configManagerKfx } from './kfx/config-manager';
import { journalManagerKfx } from './kfx/journal-manager';
import { kfxManagerKfx, wireKfxManagerRegistry } from './kfx/kfx-manager';
import { rewindInspectorKfx } from './kfx/rewind-inspector';
import { settingsKfx, wireSettingsRegistry } from './kfx/settings';
import { systemStatusKfx } from './kfx/system-status';
import { workDashboardKfx } from './kfx/work-dashboard';
import { type Runtime, bootRuntime } from './runtime';
import { loadShellState, profileById, saveShellState } from './shell-state';
import { mono, panelStyle } from './ui';

const KFX_REGISTRY: KfxManifest[] = [
  workDashboardKfx,
  rewindInspectorKfx,
  configManagerKfx,
  journalManagerKfx,
  settingsKfx,
  kfxManagerKfx,
  systemStatusKfx,
];
wireSettingsRegistry(KFX_REGISTRY);
wireKfxManagerRegistry(KFX_REGISTRY);

const SETTING_FALLBACKS: Record<string, string> = Object.fromEntries(
  KFX_REGISTRY.flatMap((manifest) =>
    (manifest.settings ?? []).map((decl) => [decl.key, decl.fallback]),
  ),
);

// One failing kfx renders its error panel; it never takes the shell down.
class KfxErrorBoundary extends React.Component<
  { kfxId: string; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { kfxId: string }) {
    if (prev.kfxId !== this.props.kfxId && this.state.error) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <section style={panelStyle}>
          <div style={{ ...mono, color: '#f48771' }}>
            kfx `{this.props.kfxId}` failed: {this.state.error.message}
          </div>
          <div style={{ ...mono, color: '#6a6a6a', marginTop: 4 }}>
            the shell and other kfx keep running — see the console for the stack
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}

function subsetCaps(
  runtime: Runtime,
  manifest: KfxManifest,
): KfxCapabilities | null {
  const full = {
    ledger: runtime.ledger,
    domain: runtime.domain,
    rewind: runtime.rewind,
    work: runtime.work,
  };
  const subset: Record<string, unknown> = {};
  for (const key of manifest.capabilities) {
    if (!full[key]) return null;
    subset[key] = full[key];
  }
  // only declared handles are populated; undeclared access is a kfx bug the
  // error boundary contains
  return subset as KfxCapabilities;
}

function App() {
  const [runtime] = React.useState(bootRuntime);
  const [state, setState] = React.useState<ShellState>(() =>
    runtime.domain
      ? loadShellState(runtime.domain)
      : { profileId: 'default', disabledKfx: [], settings: {} },
  );
  const profile = profileById(state.profileId);
  const [active, setActive] = React.useState(
    () => window.process.env.KFE_INITIAL_VIEW || profile.defaultView,
  );
  const [params, setParams] = React.useState<Record<string, string>>({});

  // shared refresh bus: one shell-owned timer, kfx subscribe
  const subscribers = React.useRef(new Set<() => void>());
  React.useEffect(() => {
    const timer = setInterval(() => {
      for (const fn of subscribers.current) fn();
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  const updateState = React.useCallback(
    (patch: Partial<ShellState>) => {
      setState((current) => {
        const next = { ...current, ...patch };
        if (runtime.domain) saveShellState(runtime.domain, next);
        return next;
      });
    },
    [runtime.domain],
  );

  const enabled = KFX_REGISTRY.filter(
    (manifest) =>
      manifest.system ||
      (profile.kfx.includes(manifest.id) &&
        !state.disabledKfx.includes(manifest.id)),
  );
  const activeKfx = enabled.find((k) => k.id === active) ?? enabled[0] ?? null;

  const shell: Shell = {
    open: (kfxId, nextParams) => {
      setParams(nextParams ?? {});
      setActive(kfxId);
    },
    params,
    onRefresh: (fn) => {
      subscribers.current.add(fn);
      return () => subscribers.current.delete(fn);
    },
    setting: (key) => state.settings[key] ?? SETTING_FALLBACKS[key] ?? '',
    updateState,
    state,
    info: {
      ok: runtime.ok,
      message: runtime.message,
      runtimeDir: runtime.runtimeDir,
      kfcVersion: runtime.kfcVersion,
      buildInfo: runtime.buildInfo,
      exports: runtime.exports,
      longfistTypes: runtime.longfistTypes,
    },
  };

  const navButton = (id: string, title: string) => (
    <button
      key={id}
      type="button"
      onClick={() => shell.open(id)}
      style={{
        ...mono,
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        background: activeKfx?.id === id ? '#04395e' : 'transparent',
        color: activeKfx?.id === id ? '#9cdcfe' : '#cccccc',
      }}
    >
      {title}
    </button>
  );

  const caps = activeKfx ? subsetCaps(runtime, activeKfx) : null;

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        color: '#cccccc',
        background: '#1e1e1e',
        height: '100vh',
        margin: 0,
        padding: 16,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
        <h1 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
          Kungfu v4 reference app
        </h1>
        <span style={{ ...mono, color: runtime.ok ? '#4ec9b0' : '#f48771' }}>
          {runtime.ok ? '●' : '○'} {runtime.message}
        </span>
        <span style={{ ...mono, color: '#6a6a6a' }}>profile: {profile.id}</span>
      </header>
      {runtime.ok ? (
        <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
          <nav style={{ width: 140, flexShrink: 0 }}>
            {enabled
              .filter((k) => !k.system)
              .map((k) => navButton(k.id, k.title))}
            <div
              style={{
                ...mono,
                color: '#6a6a6a',
                margin: '12px 0 4px',
                fontSize: 10,
              }}
            >
              system
            </div>
            {enabled
              .filter((k) => k.system)
              .map((k) => navButton(k.id, k.title))}
          </nav>
          <div style={{ flex: 1, minHeight: 0 }}>
            {activeKfx && caps ? (
              <KfxErrorBoundary kfxId={activeKfx.id}>
                <activeKfx.View caps={caps} shell={shell} />
              </KfxErrorBoundary>
            ) : (
              <p style={{ ...mono, color: '#f48771' }}>
                no kfx available for this view
              </p>
            )}
          </div>
        </div>
      ) : (
        <p style={{ ...mono, color: '#f48771' }}>
          binding unavailable — set KFE_PATH to a built kungfu_electron.node
        </p>
      )}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
