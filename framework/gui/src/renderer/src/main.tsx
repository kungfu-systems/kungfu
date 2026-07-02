// Reference app shell: boots the in-process runtime, mounts the built-in
// default kfx (config manager, journal manager) through the minimal kfx
// shape, and shows runtime/master status. See kfx.ts for the contract note.
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { KfxCapabilities, KfxManifest } from './kfx';
import { configManagerKfx } from './kfx/config-manager';
import { journalManagerKfx } from './kfx/journal-manager';
import { type Kfe, type Runtime, bootRuntime } from './runtime';
import { headingStyle, mono, panelStyle } from './ui';

const KFX_REGISTRY: KfxManifest[] = [configManagerKfx, journalManagerKfx];

function OverviewView({ runtime }: { runtime: Runtime }) {
  const kfe = runtime.kfe as Kfe;
  const registry = React.useMemo(() => {
    const lf = new kfe.Longfist();
    return Object.keys(lf.types).map((name) => {
      let fields: string[] = [];
      try {
        fields = Object.keys(lf.types[name]());
      } catch {
        fields = [];
      }
      return { name, fields };
    });
  }, [kfe]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const current = registry.find((t) => t.name === selected);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 12,
        height: '100%',
        minHeight: 0,
      }}
    >
      <section style={panelStyle}>
        <h2 style={headingStyle}>Longfist type registry · {registry.length}</h2>
        <div style={{ display: 'flex', gap: 12 }}>
          <ul
            style={{ listStyle: 'none', margin: 0, padding: 0, minWidth: 180 }}
          >
            {registry.map((t) => (
              <li key={t.name}>
                <button
                  type="button"
                  onClick={() => setSelected(t.name)}
                  style={{
                    ...mono,
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '3px 8px',
                    margin: 0,
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                    background: selected === t.name ? '#04395e' : 'transparent',
                    color: selected === t.name ? '#9cdcfe' : '#cccccc',
                  }}
                >
                  {t.name}
                </button>
              </li>
            ))}
          </ul>
          <div style={{ ...mono, color: '#ce9178', flex: 1 }}>
            {current ? (
              <>
                <div style={{ color: '#9cdcfe', marginBottom: 4 }}>
                  {current.name} · {current.fields.length} fields
                </div>
                {current.fields.map((f) => (
                  <div key={f}>{f}</div>
                ))}
              </>
            ) : (
              <span style={{ color: '#6a6a6a' }}>
                select a type — fields come from the live C++ type registry
              </span>
            )}
          </div>
        </div>
      </section>
      <section style={panelStyle}>
        <h2 style={headingStyle}>Binding exports · {runtime.exports.length}</h2>
        <ul
          style={{
            ...mono,
            columns: 2,
            color: '#9cdcfe',
            margin: 0,
            paddingLeft: 16,
          }}
        >
          {runtime.exports.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function App() {
  const [runtime] = React.useState(bootRuntime);
  const versions = window.process.versions;
  const [live, setLive] = React.useState(false);
  const [active, setActive] = React.useState('overview');

  React.useEffect(() => {
    const watcher = runtime.watcher;
    if (!watcher) return;
    try {
      if (!watcher.isStarted()) watcher.start();
    } catch {
      // master not reachable — stays offline
    }
    const timer = setInterval(() => {
      try {
        setLive(watcher.isLive());
      } catch {
        setLive(false);
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [runtime.watcher]);

  const caps: KfxCapabilities | null = runtime.kfe
    ? { kfe: runtime.kfe, runtimeDir: runtime.runtimeDir }
    : null;
  const activeKfx = KFX_REGISTRY.find((k) => k.id === active);

  const navButton = (id: string, title: string) => (
    <button
      key={id}
      type="button"
      onClick={() => setActive(id)}
      style={{
        ...mono,
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '6px 10px',
        border: 'none',
        borderRadius: 4,
        cursor: 'pointer',
        background: active === id ? '#04395e' : 'transparent',
        color: active === id ? '#9cdcfe' : '#cccccc',
      }}
    >
      {title}
    </button>
  );

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
      </header>
      <div style={{ ...mono, color: '#858585' }}>
        core {String(runtime.buildInfo?.version ?? 'unknown')} · kfc{' '}
        {runtime.kfcVersion || 'unavailable'} · electron {versions.electron} ·
        node {versions.node} · watcher {runtime.watcherState} ·{' '}
        <span style={{ color: live ? '#4ec9b0' : '#858585' }}>
          {live ? '● live (master connected)' : '○ offline (no master)'}
        </span>
        <br />
        runtime home: {runtime.runtimeDir}
      </div>
      {runtime.ok && caps ? (
        <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0 }}>
          <nav style={{ width: 140, flexShrink: 0 }}>
            {navButton('overview', 'Overview')}
            {KFX_REGISTRY.map((kfx) => navButton(kfx.id, kfx.title))}
            <div
              style={{ ...mono, color: '#6a6a6a', marginTop: 12, fontSize: 10 }}
            >
              built-in kfx · node-integrated
            </div>
          </nav>
          <div style={{ flex: 1, minHeight: 0 }}>
            {activeKfx ? (
              <activeKfx.View caps={caps} />
            ) : (
              <OverviewView runtime={runtime} />
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
