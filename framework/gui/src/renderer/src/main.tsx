import * as capability from '@kungfu-tech/api/capability';
// Reference app shell: boots the in-process runtime and mounts kfx loaded
// from extension packages. The shell owns system concerns only — extension
// scanning and lifecycle, capability injection by declaration, navigation
// with params, the shared refresh bus, shell state (profile / disabled kfx
// and suites / settings, persisted in the runtime home's ConfigStore) and
// the per-kfx error boundary. The shell ships no views of its own: every
// view — including Settings, the kfx manager and Status (the System Suite
// under extensions/system) — is an installable package; the shell keeps
// only a minimal failure surface so a broken install still boots to an
// explanation. See docs/shell-and-kfx.md.
import type {
  KfxCapabilities,
  KfxEntry,
  Shell,
  ShellState,
} from '@kungfu-tech/kfx';
import { mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import { type KfxLoadResult, loadKfx } from './kfx-loader';
import { type Runtime, bootRuntime } from './runtime';
import { sandboxClient } from './sandbox-client';
import {
  PROFILES,
  loadShellState,
  profileById,
  saveShellState,
} from './shell-state';

// Modules injected into every kfx bundle (the externals contract of
// `kfs kfx build`): one React instance, one capability surface.
const SHARED_MODULES = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': ReactDOM,
  '@kungfu-tech/api': capability,
  '@kungfu-tech/api/capability': capability,
};

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

function subsetCaps(runtime: Runtime, entry: KfxEntry): KfxCapabilities | null {
  const full = {
    ledger: runtime.ledger,
    domain: runtime.domain,
    rewind: runtime.rewind,
    work: runtime.work,
  } as Record<string, unknown>;
  const subset: Record<string, unknown> = {};
  for (const key of entry.capabilities) {
    if (!full[key]) return null;
    subset[key] = full[key];
  }
  // only declared handles are populated; undeclared access is a kfx bug the
  // error boundary contains
  return subset as unknown as KfxCapabilities;
}

// The declared capability handles the trusted renderer holds for a sandboxed
// view. Unlike subsetCaps this never returns null: a missing handle is simply
// absent, and the trusted host rejects a call to it — the sandboxed view has no
// direct handle to fault on. These stay in this (trusted) renderer; only invoke
// results cross to the isolated view.
function sandboxSubset(
  runtime: Runtime,
  entry: KfxEntry,
): Record<string, Record<string, unknown>> {
  const full: Record<string, unknown> = {
    ledger: runtime.ledger,
    domain: runtime.domain,
    rewind: runtime.rewind,
    work: runtime.work,
  };
  const subset: Record<string, Record<string, unknown>> = {};
  for (const key of entry.capabilities) {
    const handle = full[key];
    if (handle) subset[key] = handle as Record<string, unknown>;
  }
  return subset;
}

// A sandboxed-ipc view is not mounted in this renderer. The shell registers its
// trusted capability host, asks main to embed the isolated WebContentsView, and
// keeps the overlay positioned over this slot's content rect. The slot itself is
// an empty box; the view renders in its own process, layered above.
function SandboxSlot({
  entry,
  caps,
}: {
  entry: KfxEntry;
  caps: Record<string, Record<string, unknown>>;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  // caps identity is stable for a given runtime and entry.capabilities is a
  // property of the same entry; re-embedding keys only on the view identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: caps/entry.capabilities are stable per active view; re-embed keys on id + bundlePath only
  React.useEffect(() => {
    const id = entry.id;
    const sync = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      sandboxClient.setBounds(id, {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    };
    sandboxClient.registerHost(id, caps, entry.capabilities);
    let cancelled = false;
    void sandboxClient
      .ensure(id, {
        bundlePath: entry.bundlePath,
        declared: entry.capabilities,
      })
      .then(() => {
        if (cancelled) return;
        sync();
        sandboxClient.show(id);
      });
    const ro = new ResizeObserver(sync);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', sync);
    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener('resize', sync);
      sandboxClient.destroy(id);
      sandboxClient.disposeHost(id);
    };
    // re-embed only when the active sandboxed view changes; caps identity is
    // stable for a given runtime
  }, [entry.id, entry.bundlePath]);
  return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
}

function App() {
  const [runtime] = React.useState(bootRuntime);
  const [loaded] = React.useState<KfxLoadResult>(() =>
    loadKfx(window.process.env, SHARED_MODULES),
  );
  const [state, setState] = React.useState<ShellState>(() =>
    runtime.domain
      ? loadShellState(runtime.domain)
      : {
          profileId: 'default',
          disabledKfx: [],
          disabledSuites: [],
          settings: {},
        },
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

  const settingFallbacks: Record<string, string> = Object.fromEntries(
    loaded.entries.flatMap((entry) =>
      entry.settings.map((decl) => [decl.key, decl.fallback]),
    ),
  );

  const enabled = loaded.entries.filter(
    (entry) =>
      entry.system ||
      (profile.kfx.includes(entry.id) &&
        !state.disabledKfx.includes(entry.id) &&
        !(entry.suite && state.disabledSuites.includes(entry.suite))),
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
    setting: (key) => state.settings[key] ?? settingFallbacks[key] ?? '',
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
    registry: loaded.entries,
    suites: loaded.suites,
    profiles: PROFILES,
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
  const suiteTitle = (entry: KfxEntry) =>
    entry.suite ? (loaded.suites[entry.suite]?.title ?? entry.suite) : null;
  const plain = enabled.filter((k) => !k.suite);
  const suiteGroups = new Map<string, KfxEntry[]>();
  for (const entry of enabled) {
    if (!entry.suite) continue;
    const group = suiteGroups.get(entry.suite) ?? [];
    group.push(entry);
    suiteGroups.set(entry.suite, group);
  }

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
          <nav style={{ width: 150, flexShrink: 0 }}>
            {plain.map((k) => navButton(k.id, k.title))}
            {[...suiteGroups.entries()].map(([key, group]) => (
              <React.Fragment key={key}>
                <div
                  style={{
                    ...mono,
                    color: '#6a6a6a',
                    margin: '12px 0 4px',
                    fontSize: 10,
                  }}
                >
                  {suiteTitle(group[0]) ?? key}
                </div>
                {group.map((k) => navButton(k.id, k.title))}
              </React.Fragment>
            ))}
            {loaded.failures.length > 0 && (
              <div
                style={{
                  ...mono,
                  color: '#f48771',
                  marginTop: 12,
                  fontSize: 10,
                }}
              >
                {loaded.failures.length} kfx failed to load
              </div>
            )}
          </nav>
          <div style={{ flex: 1, minHeight: 0 }}>
            {activeKfx && activeKfx.tier === 'sandboxed-ipc' ? (
              // isolated third-party view: embedded, not mounted here
              <KfxErrorBoundary kfxId={activeKfx.id}>
                <SandboxSlot
                  key={activeKfx.id}
                  entry={activeKfx}
                  caps={sandboxSubset(runtime, activeKfx)}
                />
              </KfxErrorBoundary>
            ) : activeKfx && caps ? (
              <KfxErrorBoundary kfxId={activeKfx.id}>
                <activeKfx.View caps={caps} shell={shell} />
              </KfxErrorBoundary>
            ) : (
              <section style={panelStyle}>
                <div style={{ ...mono, color: '#f48771' }}>
                  no kfx available
                  {loaded.entries.length === 0
                    ? ' — no extensions found on the extension path'
                    : ` for view "${active}"`}
                </div>
                {loaded.failures.map((failure) => (
                  <div
                    key={failure.dir}
                    style={{ ...mono, color: '#858585', marginTop: 4 }}
                  >
                    {failure.dir}: {failure.error}
                  </div>
                ))}
              </section>
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
