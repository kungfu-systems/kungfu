// System kfx: system status. Runtime facts (master liveness, versions,
// binding exports, runtime home) plus the live longfist type registry — the
// diagnostics face of the shell. The future storage health story
// (fsck/export overview) mounts here.
import React from 'react';
import type { KfxCapabilities, KfxManifest, Shell } from '../kfx';
import { headingStyle, mono, panelStyle } from '../ui';

function SystemStatusView({
  caps,
  shell,
}: {
  caps: KfxCapabilities;
  shell: Shell;
}) {
  const [live, setLive] = React.useState(() => caps.ledger.health().live);
  React.useEffect(
    () => shell.onRefresh(() => setLive(caps.ledger.health().live)),
    [shell, caps.ledger],
  );

  const [selected, setSelected] = React.useState<string | null>(null);
  const registry = shell.info.longfistTypes;
  const current = registry.find((t) => t.name === selected);

  const info = shell.info;
  const versions = window.process.versions;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <section style={panelStyle}>
        <h2 style={headingStyle}>Runtime</h2>
        <div style={{ ...mono }}>
          <div>
            master:{' '}
            <span style={{ color: live ? '#4ec9b0' : '#858585' }}>
              {live ? '● live (connected)' : '○ offline (no master)'}
            </span>
          </div>
          <div>core: {String(info.buildInfo?.version ?? 'unknown')}</div>
          <div>kfc: {info.kfcVersion || 'unavailable'}</div>
          <div>
            electron: {versions.electron} · node: {versions.node}
          </div>
          <div>runtime home: {info.runtimeDir}</div>
          <div style={{ color: info.ok ? '#4ec9b0' : '#f48771' }}>
            binding: {info.message}
          </div>
        </div>
        <h2 style={{ ...headingStyle, marginTop: 12 }}>
          Binding exports · {info.exports.length}
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
          {info.exports.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </section>
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
    </div>
  );
}

export const systemStatusKfx: KfxManifest = {
  id: 'system-status',
  title: 'Status',
  runtime: 'node-integrated',
  capabilities: ['ledger'],
  system: true,
  View: SystemStatusView,
};
