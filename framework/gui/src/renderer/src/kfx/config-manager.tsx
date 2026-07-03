// Default kfx: configuration management. Location-scoped CRUD through the
// capability SDK's domain-state handle — real SQLite writes via libkungfu.
import type { ConfigEntry } from '@kungfu-tech/api/capability';
import React from 'react';
import type { KfxCapabilities, KfxManifest, Shell } from '../kfx';
import { headingStyle, inputStyle, mono, panelStyle } from '../ui';

function ConfigManagerView({ caps }: { caps: KfxCapabilities; shell: Shell }) {
  const { domain } = caps;
  const [entries, setEntries] = React.useState<ConfigEntry[]>([]);
  const [category, setCategory] = React.useState('system');
  const [group, setGroup] = React.useState('demo');
  const [name, setName] = React.useState('hello');
  const [mode, setMode] = React.useState('live');
  const [value, setValue] = React.useState('{"from":"config manager kfx"}');
  const [error, setError] = React.useState('');

  const refresh = React.useCallback(() => {
    try {
      setEntries(domain.configs());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }, [domain]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  const save = () => {
    try {
      JSON.parse(value);
      domain.setConfig({ category, group, name, mode }, value);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const remove = (entry: ConfigEntry) => {
    try {
      domain.removeConfig(entry.location);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section style={{ ...panelStyle, height: '100%' }}>
      <h2 style={headingStyle}>
        Config manager · {entries.length} entries · via capability SDK
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
          {entries.map((entry) => {
            const key = `${entry.location.category}/${entry.location.group}/${entry.location.name}/${entry.location.mode}`;
            return (
              <tr key={key} style={{ borderTop: '1px solid #3c3c3c' }}>
                <td style={{ padding: '4px 8px', color: '#858585' }}>{key}</td>
                <td style={{ padding: '4px 8px', color: '#ce9178' }}>
                  {entry.value}
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
            );
          })}
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
  capabilities: ['domain'],
  View: ConfigManagerView,
};
