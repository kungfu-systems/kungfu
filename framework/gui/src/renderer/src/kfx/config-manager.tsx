// Default kfx: configuration management. Location-scoped CRUD over the
// runtime's config store — real SQLite writes through libkungfu.
import React from 'react';
import type { KfxCapabilities, KfxManifest } from '../kfx';
import { headingStyle, inputStyle, mono, panelStyle } from '../ui';

function ConfigManagerView({ caps }: { caps: KfxCapabilities }) {
  const store = React.useMemo(
    () => new caps.kfe.ConfigStore(caps.runtimeDir),
    [caps],
  );
  const [entries, setEntries] = React.useState<Array<Record<string, unknown>>>(
    [],
  );
  const [category, setCategory] = React.useState('system');
  const [group, setGroup] = React.useState('demo');
  const [name, setName] = React.useState('hello');
  const [mode, setMode] = React.useState('live');
  const [value, setValue] = React.useState('{"from":"config manager kfx"}');
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
      store.setConfig(category, group, name, mode, value);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = (entry: Record<string, unknown>) => {
    try {
      const categories: Record<string, string> = {
        '0': 'md',
        '1': 'td',
        '2': 'strategy',
        '3': 'system',
      };
      const modes: Record<string, string> = {
        '0': 'live',
        '1': 'data',
        '2': 'replay',
        '3': 'backtest',
      };
      store.removeConfig(
        categories[String(entry.category)] ?? String(entry.category),
        String(entry.group),
        String(entry.name),
        modes[String(entry.mode)] ?? String(entry.mode),
      );
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section style={{ ...panelStyle, height: '100%' }}>
      <h2 style={headingStyle}>
        Config manager · {entries.length} entries · SQLite via libkungfu
      </h2>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="category"
          style={{ ...inputStyle, width: 80 }}
        />
        <input
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          placeholder="group"
          style={{ ...inputStyle, width: 80 }}
        />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="name"
          style={{ ...inputStyle, width: 100 }}
        />
        <input
          value={mode}
          onChange={(e) => setMode(e.target.value)}
          placeholder="mode"
          style={{ ...inputStyle, width: 60 }}
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="JSON value"
          style={{ ...inputStyle, flex: 1 }}
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
                {String(entry.category)}/{String(entry.group)}/
                {String(entry.name)}/{String(entry.mode)}
              </td>
              <td style={{ padding: '4px 8px', color: '#ce9178' }}>
                {String(entry.value)}
              </td>
              <td style={{ padding: '4px 0', width: 24 }}>
                <button
                  type="button"
                  onClick={() => remove(entry)}
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
                no entries — write one above
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

export const configManagerKfx: KfxManifest = {
  id: 'config-manager',
  title: 'Config',
  runtime: 'node-integrated',
  View: ConfigManagerView,
};
