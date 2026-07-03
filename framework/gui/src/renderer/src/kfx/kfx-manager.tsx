// System kfx: kfx manager. Lists every registered kfx with its declared
// capabilities and lets the user enable/disable non-system ones; the choice
// persists through the shell state blob. Disabling never unloads code — it
// only removes the view from navigation, which is all an internal registry
// needs before external kfx loading exists.
import React from 'react';
import type { KfxCapabilities, KfxManifest, Shell } from '../kfx';
import { profileById } from '../shell-state';
import { headingStyle, mono, panelStyle } from '../ui';

let REGISTRY: KfxManifest[] = [];
export function wireKfxManagerRegistry(manifests: KfxManifest[]) {
  REGISTRY = manifests;
}

function KfxManagerView({ shell }: { caps: KfxCapabilities; shell: Shell }) {
  const profile = profileById(shell.state.profileId);

  const toggle = (id: string, disabled: boolean) => {
    shell.updateState({
      disabledKfx: disabled
        ? shell.state.disabledKfx.filter((entry) => entry !== id)
        : [...shell.state.disabledKfx, id],
    });
  };

  return (
    <section style={panelStyle}>
      <h2 style={headingStyle}>
        Kfx · {REGISTRY.length} registered · profile: {profile.id}
      </h2>
      <table style={{ ...mono, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: '#858585', textAlign: 'left' }}>
            <th style={{ padding: '2px 12px 2px 0' }}>id</th>
            <th style={{ padding: '2px 12px 2px 0' }}>title</th>
            <th style={{ padding: '2px 12px 2px 0' }}>capabilities</th>
            <th style={{ padding: '2px 12px 2px 0' }}>kind</th>
            <th style={{ padding: '2px 12px 2px 0' }}>state</th>
          </tr>
        </thead>
        <tbody>
          {REGISTRY.map((manifest) => {
            const inProfile =
              manifest.system || profile.kfx.includes(manifest.id);
            const disabled = shell.state.disabledKfx.includes(manifest.id);
            return (
              <tr key={manifest.id}>
                <td style={{ padding: '2px 12px 2px 0', color: '#9cdcfe' }}>
                  {manifest.id}
                </td>
                <td style={{ padding: '2px 12px 2px 0' }}>{manifest.title}</td>
                <td style={{ padding: '2px 12px 2px 0', color: '#ce9178' }}>
                  {manifest.capabilities.join(', ') || '—'}
                </td>
                <td style={{ padding: '2px 12px 2px 0', color: '#858585' }}>
                  {manifest.system ? 'system' : 'profile'}
                </td>
                <td style={{ padding: '2px 12px 2px 0' }}>
                  {manifest.system ? (
                    <span style={{ color: '#6a6a6a' }}>always on</span>
                  ) : !inProfile ? (
                    <span style={{ color: '#6a6a6a' }}>not in profile</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => toggle(manifest.id, disabled)}
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
    </section>
  );
}

export const kfxManagerKfx: KfxManifest = {
  id: 'kfx-manager',
  title: 'Kfx',
  runtime: 'node-integrated',
  capabilities: [],
  system: true,
  View: KfxManagerView,
};
