import React from 'react';
import { createRoot } from 'react-dom/client';

// nodeIntegration exposes node `require` on window; use it to load the native
// kungfu binding at runtime from a vite-built (ESM) renderer. This is the moat:
// the renderer reaches the in-process runtime directly, no IPC copy.
declare global {
  interface Window {
    require: NodeRequire;
    process: NodeJS.Process;
  }
}

type Kfe = {
  Longfist: new () => { types: Record<string, () => Record<string, unknown>> };
  ConfigStore: new (
    runtimeDir: string,
  ) => {
    setConfig: (
      category: string,
      group: string,
      name: string,
      mode: string,
      value: string,
    ) => boolean;
    removeConfig: (
      category: string,
      group: string,
      name: string,
      mode: string,
    ) => boolean;
    getAllConfig: () => Record<string, Record<string, unknown>>;
  };
  SessionStore: new (
    location: Record<string, string>,
    runtimeDir: string,
  ) => { getAllSessions: () => unknown };
  Watcher: new (
    runtimeDir: string,
    name: string,
    bypassRestore: boolean,
    bypassAccounting: boolean,
    bypassTradingData: boolean,
    refreshTradingDataBeforeSync: boolean,
    bypassRefreshBook: boolean,
    millisecondsSleepAfterStep: number,
  ) => { isUsable: () => boolean; isLive: () => boolean };
};

const bigintSafe = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

const DEMO_LOCATION = {
  category: 'system',
  group: 'demo',
  name: 'reference-app',
  mode: 'live',
};

type Runtime = {
  ok: boolean;
  message: string;
  runtimeDir: string;
  kfcVersion: string;
  buildInfo: Record<string, unknown> | null;
  exports: string[];
  kfe: Kfe | null;
  watcherState: string;
};

function bootRuntime(): Runtime {
  const env = window.process.env;
  const runtimeDir = env.KF_RUNTIME_DIR || '';
  const base: Omit<Runtime, 'ok' | 'message'> = {
    runtimeDir,
    kfcVersion: env.KFC_VERSION || '',
    buildInfo: null,
    exports: [],
    kfe: null,
    watcherState: 'not constructed',
  };
  try {
    const bindingPath = env.KFE_PATH;
    if (!bindingPath) {
      return { ...base, ok: false, message: 'KFE_PATH not set' };
    }
    const kfe = window.require(bindingPath) as Kfe;
    let buildInfo: Record<string, unknown> | null = null;
    try {
      const fs = window.require('node:fs');
      const path = window.require('node:path');
      buildInfo = JSON.parse(
        fs.readFileSync(
          path.join(path.dirname(bindingPath), 'kungfubuildinfo.json'),
          'utf8',
        ),
      );
    } catch {
      buildInfo = null;
    }
    // Constructing a Watcher initializes the runtime home (profile db layout)
    // so the stores below work against a fresh directory.
    let watcherState = 'not constructed';
    try {
      const watcher = new kfe.Watcher(
        runtimeDir,
        'reference_app',
        true,
        true,
        true,
        false,
        true,
        50,
      );
      watcherState = `constructed · usable=${watcher.isUsable()} live=${watcher.isLive()}`;
    } catch (e) {
      watcherState = `failed: ${(e as Error).message}`;
    }
    return {
      ...base,
      ok: true,
      message: `in-process binding loaded · ${Object.keys(kfe).length} exports`,
      buildInfo,
      exports: Object.keys(kfe),
      kfe,
      watcherState,
    };
  } catch (e) {
    return { ...base, ok: false, message: (e as Error).message };
  }
}

const panelStyle: React.CSSProperties = {
  background: '#252526',
  border: '1px solid #3c3c3c',
  borderRadius: 6,
  padding: 12,
  overflow: 'auto',
  minHeight: 0,
};

const headingStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: '#858585',
  margin: '0 0 8px 0',
};

const mono: React.CSSProperties = {
  fontFamily: 'SF Mono, Menlo, monospace',
  fontSize: 12,
};

function LongfistPanel({ kfe }: { kfe: Kfe }) {
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
    <section style={panelStyle}>
      <h2 style={headingStyle}>Longfist type registry · {registry.length}</h2>
      <div style={{ display: 'flex', gap: 12 }}>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, minWidth: 180 }}>
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
  );
}

function ConfigStorePanel({
  kfe,
  runtimeDir,
}: {
  kfe: Kfe;
  runtimeDir: string;
}) {
  const store = React.useMemo(
    () => new kfe.ConfigStore(runtimeDir),
    [kfe, runtimeDir],
  );
  const [entries, setEntries] = React.useState<Array<Record<string, unknown>>>(
    [],
  );
  const [name, setName] = React.useState('hello');
  const [value, setValue] = React.useState('{"from":"reference app"}');
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(() => {
    try {
      setEntries(Object.values(store.getAllConfig()));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [store]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const save = () => {
    try {
      JSON.parse(value);
      store.setConfig('system', 'demo', name, 'live', value);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = (group: string, entryName: string) => {
    try {
      store.removeConfig('system', group, entryName, 'live');
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section style={panelStyle}>
      <h2 style={headingStyle}>
        ConfigStore · live SQLite round-trip through libkungfu
      </h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
          style={{ ...mono, width: 120, padding: 4 }}
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="JSON value"
          style={{ ...mono, flex: 1, padding: 4 }}
        />
        <button
          type="button"
          onClick={save}
          style={{ ...mono, padding: '4px 12px' }}
        >
          write
        </button>
      </div>
      {error && <div style={{ ...mono, color: '#f48771' }}>{error}</div>}
      <table style={{ ...mono, borderCollapse: 'collapse', width: '100%' }}>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={String(entry.uid64)}
              style={{ borderTop: '1px solid #3c3c3c' }}
            >
              <td style={{ padding: '4px 8px', color: '#858585' }}>
                {String(entry.group)}/{String(entry.name)}
              </td>
              <td style={{ padding: '4px 8px', color: '#ce9178' }}>
                {String(entry.value)}
              </td>
              <td style={{ padding: '4px 0', width: 24 }}>
                <button
                  type="button"
                  onClick={() =>
                    remove(String(entry.group), String(entry.name))
                  }
                  style={{ ...mono, color: '#f48771' }}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
          {entries.length === 0 && (
            <tr>
              <td style={{ ...mono, color: '#6a6a6a', padding: 8 }}>
                no entries yet — write one above; it lands in {runtimeDir}
                /db/system/etc/kungfu/live/config.db
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function SessionsPanel({ kfe, runtimeDir }: { kfe: Kfe; runtimeDir: string }) {
  const sessions = React.useMemo(() => {
    try {
      const store = new kfe.SessionStore(DEMO_LOCATION, runtimeDir);
      const all = store.getAllSessions();
      return { ok: true, text: JSON.stringify(all, bigintSafe, 2) };
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  }, [kfe, runtimeDir]);

  return (
    <section style={panelStyle}>
      <h2 style={headingStyle}>Runs · SessionStore</h2>
      <pre style={{ ...mono, color: sessions.ok ? '#ce9178' : '#f48771' }}>
        {sessions.ok && (sessions.text === '{}' || sessions.text === '[]')
          ? 'no recorded runs in this runtime home yet — journals appear here once a runtime writes'
          : sessions.text}
      </pre>
    </section>
  );
}

function App() {
  const [runtime] = React.useState(bootRuntime);
  const versions = window.process.versions;

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
        node {versions.node} · watcher {runtime.watcherState}
        <br />
        runtime home: {runtime.runtimeDir}
      </div>
      {runtime.ok && runtime.kfe ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gridTemplateRows: '1fr 1fr',
            gap: 12,
            flex: 1,
            minHeight: 0,
          }}
        >
          <LongfistPanel kfe={runtime.kfe} />
          <ConfigStorePanel kfe={runtime.kfe} runtimeDir={runtime.runtimeDir} />
          <SessionsPanel kfe={runtime.kfe} runtimeDir={runtime.runtimeDir} />
          <section style={panelStyle}>
            <h2 style={headingStyle}>
              Binding exports · {runtime.exports.length}
            </h2>
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
      ) : (
        <p style={{ ...mono, color: '#f48771' }}>
          binding unavailable — set KFE_PATH to a built kungfu_electron.node
        </p>
      )}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
