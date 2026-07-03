// System view: Settings. Profile selection plus every settings entry the
// loaded kfx contribute through their manifests. Values persist in the
// runtime home's ConfigStore via the shell — one journal-backed state blob,
// readable by CLI and agent APIs alike.
import {
  type KfxViewProps,
  headingStyle,
  inputStyle,
  mono,
  panelStyle,
} from '@kungfu-tech/kfx';
import React from 'react';

function SettingsView({ shell }: KfxViewProps) {
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});

  const declared = shell.registry.flatMap((entry) =>
    entry.settings.map((decl) => ({ owner: entry.title, decl })),
  );

  const commit = (key: string) => {
    const value = drafts[key];
    if (value === undefined) return;
    shell.updateState({ settings: { ...shell.state.settings, [key]: value } });
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <section style={panelStyle}>
        <h2 style={headingStyle}>Profile</h2>
        {shell.profiles.map((profile) => (
          <label
            key={profile.id}
            style={{
              ...mono,
              display: 'block',
              padding: '4px 0',
              cursor: 'pointer',
            }}
          >
            <input
              type="radio"
              name="profile"
              checked={shell.state.profileId === profile.id}
              onChange={() => shell.updateState({ profileId: profile.id })}
            />{' '}
            {profile.title}
            <span style={{ color: '#6a6a6a' }}>
              {'  '}kfx: {profile.kfx.join(', ')} · first screen:{' '}
              {profile.defaultView}
            </span>
          </label>
        ))}
        <div style={{ ...mono, color: '#6a6a6a', marginTop: 8, fontSize: 11 }}>
          a profile selects kfx and the first screen; system views are always
          available
        </div>
      </section>
      <section style={panelStyle}>
        <h2 style={headingStyle}>Kfx settings</h2>
        {declared.length ? (
          declared.map(({ owner, decl }) => (
            <div key={decl.key} style={{ marginBottom: 8 }}>
              <div style={{ ...mono, color: '#858585' }}>
                {owner} · {decl.label}{' '}
                <span style={{ color: '#6a6a6a' }}>({decl.key})</span>
              </div>
              <input
                style={{ ...inputStyle, width: 200 }}
                value={drafts[decl.key] ?? shell.setting(decl.key)}
                onChange={(e) =>
                  setDrafts((current) => ({
                    ...current,
                    [decl.key]: e.target.value,
                  }))
                }
                onBlur={() => commit(decl.key)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit(decl.key);
                }}
              />
            </div>
          ))
        ) : (
          <div style={{ ...mono, color: '#6a6a6a' }}>
            no kfx contributed settings
          </div>
        )}
      </section>
    </div>
  );
}

export const View = SettingsView;
