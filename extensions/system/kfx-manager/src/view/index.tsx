// System view: kfx manager. Lists every loaded kfx with its suite, declared
// capabilities, package coordinates and load source, and lets the user
// enable/disable non-system kfx individually or a whole suite as a unit; the
// choice persists through the shell state blob. Disabling never unloads code
// — it only removes views from navigation.
import {
  type KfxViewProps,
  headingStyle,
  mono,
  panelStyle,
} from '@kungfu-tech/kfx';
import React from 'react';

function KfxManagerView({ shell }: KfxViewProps) {
  const profile =
    shell.profiles.find((p) => p.id === shell.state.profileId) ??
    shell.profiles[0];

  const toggleKfx = (id: string, disabled: boolean) => {
    shell.updateState({
      disabledKfx: disabled
        ? shell.state.disabledKfx.filter((entry) => entry !== id)
        : [...shell.state.disabledKfx, id],
    });
  };

  const toggleSuite = (key: string, disabled: boolean) => {
    shell.updateState({
      disabledSuites: disabled
        ? shell.state.disabledSuites.filter((entry) => entry !== key)
        : [...shell.state.disabledSuites, key],
    });
  };

  const cell: React.CSSProperties = { padding: '2px 12px 2px 0' };

  return (
    <section style={panelStyle}>
      <h2 style={headingStyle}>
        Kfx · {shell.registry.length} loaded · profile: {profile?.id}
      </h2>
      <table style={{ ...mono, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: '#858585', textAlign: 'left' }}>
            <th style={cell}>id</th>
            <th style={cell}>title</th>
            <th style={cell}>suite</th>
            <th style={cell}>capabilities</th>
            <th style={cell}>package</th>
            <th style={cell}>source</th>
            <th style={cell}>state</th>
          </tr>
        </thead>
        <tbody>
          {shell.registry.map((entry) => {
            const inProfile =
              entry.system || (profile?.kfx.includes(entry.id) ?? false);
            const disabled = shell.state.disabledKfx.includes(entry.id);
            return (
              <tr key={entry.id}>
                <td style={{ ...cell, color: '#9cdcfe' }}>{entry.id}</td>
                <td style={cell}>{entry.title}</td>
                <td style={{ ...cell, color: '#858585' }}>
                  {entry.suite ?? '—'}
                </td>
                <td style={{ ...cell, color: '#ce9178' }}>
                  {entry.capabilities.join(', ') || '—'}
                </td>
                <td style={{ ...cell, color: '#858585' }}>
                  {entry.packageName
                    ? `${entry.packageName}@${entry.version ?? '?'}`
                    : '—'}
                </td>
                <td style={{ ...cell, color: '#6a6a6a' }}>{entry.source}</td>
                <td style={cell}>
                  {entry.system ? (
                    <span style={{ color: '#6a6a6a' }}>system · always on</span>
                  ) : !inProfile ? (
                    <span style={{ color: '#6a6a6a' }}>not in profile</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggleKfx(entry.id, disabled)}
                      style={{
                        ...mono,
                        padding: '1px 8px',
                        border: '1px solid #3c3c3c',
                        borderRadius: 4,
                        cursor: 'pointer',
                        background: 'transparent',
                        color: disabled ? '#f48771' : '#4ec9b0',
                      }}
                    >
                      {disabled ? 'disabled — enable' : 'enabled — disable'}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h2 style={{ ...headingStyle, marginTop: 12 }}>
        Suites · {Object.keys(shell.suites).length}
      </h2>
      {Object.entries(shell.suites).map(([key, suite]) => {
        const disabled = shell.state.disabledSuites.includes(key);
        const isSystem = shell.registry.some(
          (entry) => entry.suite === key && entry.system,
        );
        return (
          <div key={key} style={{ ...mono, padding: '2px 0' }}>
            <span style={{ color: '#9cdcfe' }}>{key}</span> · {suite.title} ·
            members: {suite.members.join(', ')}{' '}
            {isSystem ? (
              <span style={{ color: '#6a6a6a' }}>system · always on</span>
            ) : (
              <button
                type="button"
                onClick={() => toggleSuite(key, disabled)}
                style={{
                  ...mono,
                  padding: '1px 8px',
                  border: '1px solid #3c3c3c',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: 'transparent',
                  color: disabled ? '#f48771' : '#4ec9b0',
                }}
              >
                {disabled ? 'suite disabled — enable' : 'suite enabled — disable'}
              </button>
            )}
          </div>
        );
      })}
    </section>
  );
}

export const View = KfxManagerView;
