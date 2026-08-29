// System view: Settings. Profile selection plus every settings entry the
// loaded kfx contribute through their manifests. Values persist in the
// runtime home's ConfigStore via the shell — one journal-backed state blob,
// readable by CLI and agent APIs alike.
import {
  type AgentRuntimeCatalog,
  type AgentRuntimeProfileInput,
  type KfxViewProps,
  headingStyle,
  inputStyle,
  mono,
} from '@kungfu-tech/kfx';
import React from 'react';

const tabs = [
  'appearance',
  'agents',
  'profile',
  'kfx',
  'paths',
  'advanced',
] as const;
type SettingsTab = (typeof tabs)[number];

const tabLabels: Record<SettingsTab, string> = {
  appearance: 'Appearance',
  agents: 'Agents',
  profile: 'Profile',
  kfx: 'KFX',
  paths: 'Paths',
  advanced: 'Advanced',
};

const sectionStyle: React.CSSProperties = {
  borderTop: '1px solid #3c3c3c',
  paddingTop: 12,
};

const rowStyle: React.CSSProperties = {
  ...mono,
  display: 'grid',
  gridTemplateColumns: '160px minmax(0, 1fr)',
  gap: 12,
  alignItems: 'start',
  padding: '6px 0',
};

const customFontValue = '__custom__';

const fontFamilyOptions = [
  { label: 'System UI', value: 'system' },
  {
    label: 'System Mono',
    value:
      'ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
  },
  {
    label: 'Common Sans',
    value:
      'Arial, Helvetica, "Liberation Sans", "Noto Sans", system-ui, sans-serif',
  },
  {
    label: 'Common Serif',
    value:
      'Georgia, "Times New Roman", "Liberation Serif", "Noto Serif", serif',
  },
  {
    label: 'Common Mono',
    value: 'Consolas, "Liberation Mono", Menlo, "SF Mono", Monaco, monospace',
  },
] as const;

function shellEnv(key: string): string {
  return window.process.env[key] || '—';
}

const emptyAgentDraft: AgentRuntimeProfileInput = {
  id: 'codex.custom',
  label: 'Codex · Custom',
  provider: 'codex',
  executable: 'codex',
  argv: [],
  cwdPolicy: 'workspace-root',
  backend: 'tmux',
  envelope: 'required',
};

type UiDraft = { fontFamily: string; fontSize: string; scale: string };

type AppearanceSettingsProps = {
  shell: KfxViewProps['shell'];
  uiDraft: UiDraft;
  setUiDraft: React.Dispatch<React.SetStateAction<UiDraft>>;
  uiError: string;
  saveAppearance: () => void;
  resetAppearance: () => void;
};

function AppearanceSettings(props: AppearanceSettingsProps) {
  const {
    resetAppearance,
    saveAppearance,
    setUiDraft,
    shell,
    uiDraft,
    uiError,
  } = props;
  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>Global appearance</h2>
      {shell.configError && (
        <div style={{ ...mono, color: '#f48771', marginBottom: 10 }}>
          {shell.configError}
        </div>
      )}
      <div style={{ display: 'grid', gap: 10, maxWidth: 560 }}>
        <label style={rowStyle}>
          <span style={{ color: '#858585' }}>font family</span>
          <div style={{ display: 'grid', gap: 8 }}>
            <select
              style={{ ...inputStyle, width: '100%' }}
              value={
                fontFamilyOptions.some(
                  (option) => option.value === uiDraft.fontFamily,
                )
                  ? uiDraft.fontFamily
                  : customFontValue
              }
              onChange={(event) => {
                const value = event.target.value;
                setUiDraft((current) => ({
                  ...current,
                  fontFamily: value === customFontValue ? '' : value,
                }));
              }}
            >
              {fontFamilyOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              <option value={customFontValue}>Custom</option>
            </select>
            {!fontFamilyOptions.some(
              (option) => option.value === uiDraft.fontFamily,
            ) && (
              <input
                style={{ ...inputStyle, width: '100%' }}
                value={uiDraft.fontFamily}
                onChange={(event) =>
                  setUiDraft((current) => ({
                    ...current,
                    fontFamily: event.target.value,
                  }))
                }
                placeholder="Inter, system-ui, sans-serif"
              />
            )}
          </div>
        </label>
        <label style={rowStyle}>
          <span style={{ color: '#858585' }}>font size</span>
          <input
            type="number"
            min={8}
            max={48}
            step={1}
            style={{ ...inputStyle, width: 120 }}
            value={uiDraft.fontSize}
            onChange={(event) =>
              setUiDraft((current) => ({
                ...current,
                fontSize: event.target.value,
              }))
            }
          />
        </label>
        <label style={rowStyle}>
          <span style={{ color: '#858585' }}>
            zoom · {Math.round(Number(uiDraft.scale || 1) * 100)}%
          </span>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.05}
            value={uiDraft.scale}
            onChange={(event) =>
              setUiDraft((current) => ({
                ...current,
                scale: event.target.value,
              }))
            }
          />
        </label>
        <div style={{ ...mono, color: '#6a6a6a' }}>
          config: {shell.config?.configPath ?? 'unavailable'}
        </div>
        {(uiError || shell.configError) && (
          <div style={{ ...mono, color: '#f48771' }}>
            {uiError || shell.configError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={saveAppearance}
            style={{ ...mono, padding: '6px 12px' }}
          >
            Apply
          </button>
          <button
            type="button"
            onClick={resetAppearance}
            style={{ ...mono, padding: '6px 12px' }}
          >
            Reset
          </button>
          <button
            type="button"
            onClick={shell.reloadConfig}
            style={{ ...mono, padding: '6px 12px' }}
          >
            Reload
          </button>
        </div>
      </div>
    </section>
  );
}

type ProfileSettingsProps = {
  shell: KfxViewProps['shell'];
  profile: KfxViewProps['shell']['profiles'][number];
};

function ProfileSettings(props: ProfileSettingsProps) {
  const { profile, shell } = props;
  return (
    <section style={sectionStyle}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <h2 style={headingStyle}>Active profile</h2>
          {shell.profiles.map((candidate) => (
            <label
              key={candidate.id}
              style={{
                ...mono,
                display: 'block',
                padding: '6px 0',
                cursor: 'pointer',
              }}
            >
              <input
                type="radio"
                name="profile"
                checked={shell.state.profileId === candidate.id}
                onChange={() => shell.updateState({ profileId: candidate.id })}
              />{' '}
              {candidate.title}
            </label>
          ))}
        </div>
        <div>
          <h2 style={headingStyle}>Profile kfx</h2>
          <div style={{ ...mono, color: '#9cdcfe' }}>{profile.id}</div>
          <div style={{ ...mono, color: '#858585', marginTop: 6 }}>
            first screen: {profile.defaultView}
          </div>
          <div style={{ ...mono, color: '#ce9178', marginTop: 6 }}>
            {profile.kfx.join(', ')}
          </div>
        </div>
      </div>
    </section>
  );
}

type DeclaredSetting = {
  owner: string;
  decl: KfxViewProps['shell']['registry'][number]['settings'][number];
};

type KfxSettingsProps = {
  commit: (key: string) => void;
  declared: DeclaredSetting[];
  drafts: Record<string, string>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  shell: KfxViewProps['shell'];
};

function KfxSettings(props: KfxSettingsProps) {
  const { commit, declared, drafts, setDrafts, shell } = props;
  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>KFX settings</h2>
      {declared.length ? (
        <div>
          {declared.map(({ owner, decl }) => (
            <div key={decl.key} style={rowStyle}>
              <div style={{ color: '#858585' }}>
                {owner}
                <div style={{ color: '#6a6a6a' }}>{decl.key}</div>
              </div>
              <label style={{ display: 'block' }}>
                <div style={{ marginBottom: 4 }}>{decl.label}</div>
                <input
                  style={{ ...inputStyle, width: 'min(360px, 100%)' }}
                  value={drafts[decl.key] ?? shell.setting(decl.key)}
                  onChange={(event) =>
                    setDrafts((current) => ({
                      ...current,
                      [decl.key]: event.target.value,
                    }))
                  }
                  onBlur={() => commit(decl.key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commit(decl.key);
                  }}
                />
              </label>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ ...mono, color: '#6a6a6a' }}>
          no kfx contributed settings
        </div>
      )}
    </section>
  );
}

function PathsSettings({ shell }: Pick<KfxViewProps, 'shell'>) {
  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>Runtime paths</h2>
      {[
        ['runtime home', shell.info.runtimeDir],
        ['KF_HOME', shellEnv('KF_HOME')],
        ['KF_CONFIG_HOME', shellEnv('KF_CONFIG_HOME')],
        ['KF_EXTENSION_PATH', shellEnv('KF_EXTENSION_PATH')],
        ['KF_BUNDLED_EXTENSION_ROOT', shellEnv('KF_BUNDLED_EXTENSION_ROOT')],
      ].map(([label, value]) => (
        <div key={label} style={rowStyle}>
          <div style={{ color: '#858585' }}>{label}</div>
          <div style={{ color: '#9cdcfe', overflowWrap: 'anywhere' }}>
            {value}
          </div>
        </div>
      ))}
    </section>
  );
}

function AdvancedSettings({ shell }: Pick<KfxViewProps, 'shell'>) {
  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>Shell state</h2>
      <pre
        style={{
          ...mono,
          margin: 0,
          padding: 12,
          overflow: 'auto',
          border: '1px solid #3c3c3c',
          borderRadius: 6,
          background: '#1e1e1e',
          color: '#cccccc',
          maxHeight: 360,
        }}
      >
        {JSON.stringify(shell.state, null, 2)}
      </pre>
    </section>
  );
}

type SettingsTabsProps = {
  activeTab: SettingsTab;
  content: React.ReactNode;
  setActiveTab: React.Dispatch<React.SetStateAction<SettingsTab>>;
};

function SettingsTabs(props: SettingsTabsProps) {
  const { activeTab, content, setActiveTab } = props;
  return (
    <div>
      <div
        role="tablist"
        aria-label="Settings sections"
        style={{
          display: 'flex',
          gap: 6,
          marginBottom: 12,
          borderBottom: '1px solid #3c3c3c',
          paddingBottom: 8,
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            style={{
              ...mono,
              padding: '6px 10px',
              border: '1px solid #3c3c3c',
              borderRadius: 6,
              cursor: 'pointer',
              background: activeTab === tab ? '#04395e' : '#1e1e1e',
              color: activeTab === tab ? '#9cdcfe' : '#cccccc',
            }}
          >
            {tabLabels[tab]}
          </button>
        ))}
      </div>
      {content}
    </div>
  );
}

type SettingsRenderers = Record<SettingsTab, () => React.ReactNode>;

function activeSettingsContent(
  activeTab: SettingsTab,
  renderers: SettingsRenderers,
) {
  return renderers[activeTab]();
}

type ConfiguredAgent = AgentRuntimeCatalog['configured'][number];
type DiscoveredAgent = AgentRuntimeCatalog['discovered'][number];

type AgentSettingsModel = {
  agentArgv: string;
  agentBusy: boolean;
  agentCatalog: AgentRuntimeCatalog | null;
  agentDraft: AgentRuntimeProfileInput;
  agentMessage: string;
  configureDiscovered: (profile: DiscoveredAgent['profile']) => Promise<void>;
  reloadAgents: () => Promise<void>;
  removeAgent: (profileId: string) => Promise<void>;
  saveAgentDraft: () => Promise<void>;
  setAgentArgv: React.Dispatch<React.SetStateAction<string>>;
  setAgentDraft: React.Dispatch<React.SetStateAction<AgentRuntimeProfileInput>>;
  setDefaultAgent: (profileId: string) => Promise<void>;
  verifyAgent: (profileId: string) => Promise<void>;
};

type ConfiguredAgentRowProps = {
  model: AgentSettingsModel;
  profile: ConfiguredAgent;
};

function ConfiguredAgentRow(props: ConfiguredAgentRowProps) {
  const { model, profile } = props;
  const editProfile = () => {
    model.setAgentDraft({
      id: profile.id,
      label: profile.label,
      provider: profile.provider,
      executable: profile.launch.executable,
      argv: profile.launch.argv,
      shellMode: profile.launch.shellMode,
      cwdPolicy: profile.cwdPolicy,
      backend: profile.backendDefault,
      envelope: profile.bootstrap.envelope,
    });
    model.setAgentArgv(profile.launch.argv.join('\n'));
  };
  return (
    <div style={rowStyle}>
      <div>
        <div style={{ color: '#9cdcfe' }}>{profile.label}</div>
        <div style={{ color: '#6a6a6a' }}>{profile.id}</div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code style={{ overflowWrap: 'anywhere' }}>
          {profile.launch.executable}
        </code>
        <button
          type="button"
          disabled={model.agentBusy}
          onClick={() => void model.setDefaultAgent(profile.id)}
        >
          {model.agentCatalog?.defaultProfileId === profile.id
            ? 'Default ✓'
            : 'Set default'}
        </button>
        <button
          type="button"
          disabled={model.agentBusy}
          onClick={() => void model.verifyAgent(profile.id)}
        >
          Verify
        </button>
        <button type="button" disabled={model.agentBusy} onClick={editProfile}>
          Edit
        </button>
        <button
          type="button"
          disabled={model.agentBusy}
          onClick={() => void model.removeAgent(profile.id)}
        >
          Remove
        </button>
      </div>
    </div>
  );
}

type ConfiguredAgentsSectionProps = {
  model: AgentSettingsModel;
  shell: KfxViewProps['shell'];
};

function ConfiguredAgentsSection(props: ConfiguredAgentsSectionProps) {
  const { model, shell } = props;
  return (
    <div>
      <h3 style={{ ...headingStyle, fontSize: 13 }}>Configured</h3>
      <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
        <label style={{ ...mono, display: 'flex', gap: 6 }}>
          startup
          <select
            value={model.agentCatalog?.startupView ?? 'profile-home'}
            onChange={(event) => {
              shell.setConfigValue('agent.startupView', event.target.value);
              void model.reloadAgents();
            }}
          >
            <option value="profile-home">Work Control</option>
            <option value="agent-console">Agent Console</option>
          </select>
        </label>
        <label style={{ ...mono, display: 'flex', gap: 6 }}>
          default backend
          <select
            value={model.agentCatalog?.backendDefault ?? 'tmux'}
            onChange={(event) => {
              shell.setConfigValue('agent.backendDefault', event.target.value);
              void model.reloadAgents();
            }}
          >
            <option value="tmux">Durable</option>
            <option value="direct">Direct</option>
          </select>
        </label>
      </div>
      {(model.agentCatalog?.configured ?? []).map((profile) => (
        <ConfiguredAgentRow key={profile.id} model={model} profile={profile} />
      ))}
      {(model.agentCatalog?.configured.length ?? 0) === 0 && (
        <div style={{ ...mono, color: '#6a6a6a' }}>
          No saved launch method yet.
        </div>
      )}
    </div>
  );
}

type DiscoveredAgentRowProps = {
  model: AgentSettingsModel;
  row: DiscoveredAgent;
};

function DiscoveredAgentRow(props: DiscoveredAgentRowProps) {
  const { model, row } = props;
  return (
    <div style={rowStyle}>
      <div>
        <div style={{ color: '#9cdcfe' }}>{row.profile.label}</div>
        <div style={{ color: '#6a6a6a' }}>
          {row.version ?? 'version unknown'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code style={{ overflowWrap: 'anywhere' }}>
          {row.profile.launch.executable}
        </code>
        <button
          type="button"
          disabled={model.agentBusy}
          onClick={() => void model.configureDiscovered(row.profile)}
        >
          {model.agentCatalog?.defaultProfileId === row.profile.id
            ? 'Default ✓'
            : 'Use'}
        </button>
        <button
          type="button"
          disabled={model.agentBusy}
          onClick={() => void model.verifyAgent(row.profile.id)}
        >
          Verify
        </button>
      </div>
    </div>
  );
}

type DiscoveredAgentsSectionProps = { model: AgentSettingsModel };

function DiscoveredAgentsSection(props: DiscoveredAgentsSectionProps) {
  const { model } = props;
  return (
    <div>
      <h3 style={{ ...headingStyle, fontSize: 13 }}>Detected on this Mac</h3>
      {(model.agentCatalog?.discovered ?? []).map((row) => (
        <DiscoveredAgentRow key={row.profile.id} model={model} row={row} />
      ))}
      {(model.agentCatalog?.discovered.length ?? 0) === 0 && (
        <div style={{ ...mono, color: '#6a6a6a' }}>
          No Codex or Claude executable found. Add a custom method below.
        </div>
      )}
    </div>
  );
}

type AgentIdentityFieldsProps = { model: AgentSettingsModel };

function AgentIdentityFields(props: AgentIdentityFieldsProps) {
  const { model } = props;
  const fields = [
    ['id', 'stable id'],
    ['label', 'label'],
    ['executable', 'executable'],
  ] as const;
  return (
    <>
      <label style={rowStyle}>
        <span>provider</span>
        <select
          value={model.agentDraft.provider}
          onChange={(event) => {
            const provider = event.target.value as 'codex' | 'claude';
            model.setAgentDraft((current) => ({
              ...current,
              provider,
              id: `${provider}.custom`,
              label: `${provider === 'codex' ? 'Codex' : 'Claude'} · Custom`,
              executable: provider,
            }));
          }}
        >
          <option value="codex">Codex</option>
          <option value="claude">Claude</option>
        </select>
      </label>
      {fields.map(([key, label]) => (
        <label key={key} style={rowStyle}>
          <span>{label}</span>
          <input
            style={inputStyle}
            value={model.agentDraft[key]}
            onChange={(event) =>
              model.setAgentDraft((current) => ({
                ...current,
                [key]: event.target.value,
              }))
            }
          />
        </label>
      ))}
    </>
  );
}

type CustomAgentSectionProps = { model: AgentSettingsModel };

function CustomAgentSection(props: CustomAgentSectionProps) {
  const { model } = props;
  return (
    <div>
      <h3 style={{ ...headingStyle, fontSize: 13 }}>Custom method</h3>
      <div style={{ display: 'grid', gap: 8, maxWidth: 720 }}>
        <AgentIdentityFields model={model} />
        <label style={rowStyle}>
          <span>argv · one per line</span>
          <textarea
            rows={3}
            style={{ ...inputStyle, resize: 'vertical' }}
            value={model.agentArgv}
            onChange={(event) => model.setAgentArgv(event.target.value)}
            placeholder="Optional agentctl arguments"
          />
        </label>
        <label style={rowStyle}>
          <span>backend</span>
          <select
            value={model.agentDraft.backend}
            onChange={(event) =>
              model.setAgentDraft((current) => ({
                ...current,
                backend: event.target.value as 'tmux' | 'direct',
              }))
            }
          >
            <option value="tmux">Durable</option>
            <option value="direct">Direct · ends with app</option>
          </select>
        </label>
        <label style={rowStyle}>
          <span>shell mode</span>
          <span>
            <input
              type="checkbox"
              checked={model.agentDraft.shellMode ?? false}
              onChange={(event) =>
                model.setAgentDraft((current) => ({
                  ...current,
                  shellMode: event.target.checked,
                }))
              }
            />{' '}
            explicit compatibility mode · only enable for a trusted custom
            command
          </span>
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            disabled={model.agentBusy}
            onClick={() => void model.saveAgentDraft()}
          >
            Save and use
          </button>
          <button
            type="button"
            disabled={model.agentBusy}
            onClick={() => void model.reloadAgents()}
          >
            Rescan
          </button>
        </div>
      </div>
    </div>
  );
}

type AgentSettingsContentProps = {
  available: boolean;
  model: AgentSettingsModel;
  shell: KfxViewProps['shell'];
};

function AgentSettingsContent(props: AgentSettingsContentProps) {
  const { available, model, shell } = props;
  return (
    <section style={sectionStyle}>
      <h2 style={headingStyle}>Agent Runtime Profiles</h2>
      <div style={{ ...mono, color: '#858585', marginBottom: 12 }}>
        Machine-global launch methods only. Kungfu inspects executable paths and
        bounded --version output; provider auth and conversation data stay
        private.
      </div>
      {!available ? (
        <div style={{ ...mono, color: '#f48771' }}>
          Agent Runtime capability unavailable
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 16 }}>
          <ConfiguredAgentsSection model={model} shell={shell} />
          <DiscoveredAgentsSection model={model} />
          <CustomAgentSection model={model} />
          <div style={{ ...mono, color: '#6a6a6a' }}>
            config: {model.agentCatalog?.configPath ?? 'loading…'}
          </div>
          {model.agentMessage && (
            <div style={{ ...mono, color: '#dcdcaa' }}>
              {model.agentMessage}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function SettingsView({ shell, caps }: KfxViewProps) {
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = React.useState<SettingsTab>('appearance');
  const ui = shell.config?.config.ui ?? {
    fontFamily: 'system',
    fontSize: 14,
    scale: 1,
  };
  const [uiDraft, setUiDraft] = React.useState({
    fontFamily: ui.fontFamily,
    fontSize: String(ui.fontSize),
    scale: String(ui.scale),
  });
  const [uiError, setUiError] = React.useState('');
  const [agentCatalog, setAgentCatalog] =
    React.useState<AgentRuntimeCatalog | null>(null);
  const [agentDraft, setAgentDraft] =
    React.useState<AgentRuntimeProfileInput>(emptyAgentDraft);
  const [agentArgv, setAgentArgv] = React.useState('');
  const [agentMessage, setAgentMessage] = React.useState('');
  const [agentBusy, setAgentBusy] = React.useState(false);

  const reloadAgents = React.useCallback(async () => {
    if (!caps.agentRuntime) return;
    setAgentBusy(true);
    try {
      setAgentCatalog(await caps.agentRuntime.list());
      setAgentMessage('');
    } catch (error) {
      setAgentMessage((error as Error).message);
    } finally {
      setAgentBusy(false);
    }
  }, [caps.agentRuntime]);

  React.useEffect(() => {
    if (activeTab === 'agents') void reloadAgents();
  }, [activeTab, reloadAgents]);

  React.useEffect(() => {
    setUiDraft({
      fontFamily: ui.fontFamily,
      fontSize: String(ui.fontSize),
      scale: String(ui.scale),
    });
  }, [ui.fontFamily, ui.fontSize, ui.scale]);

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

  const profile =
    shell.profiles.find((p) => p.id === shell.state.profileId) ??
    shell.profiles[0];

  const saveAppearance = () => {
    const fontSize = Number(uiDraft.fontSize);
    const scale = Number(uiDraft.scale);
    if (!Number.isFinite(fontSize) || fontSize < 8 || fontSize > 48) {
      setUiError('font size must be between 8 and 48');
      return;
    }
    if (!Number.isFinite(scale) || scale < 0.5 || scale > 3) {
      setUiError('zoom must be between 50% and 300%');
      return;
    }
    const fontFamily = uiDraft.fontFamily.trim() || 'system';
    try {
      shell.setConfigValue('ui.fontFamily', fontFamily);
      shell.setConfigValue('ui.fontSize', fontSize);
      shell.setConfigValue('ui.scale', scale);
      setUiError('');
    } catch (e) {
      setUiError((e as Error).message);
    }
  };

  const resetAppearance = () => {
    try {
      shell.unsetConfigValue('ui.fontFamily');
      shell.unsetConfigValue('ui.fontSize');
      shell.unsetConfigValue('ui.scale');
      shell.reloadConfig();
      setUiError('');
    } catch (e) {
      setUiError((e as Error).message);
    }
  };

  const renderAppearance = () => (
    <AppearanceSettings
      resetAppearance={resetAppearance}
      saveAppearance={saveAppearance}
      setUiDraft={setUiDraft}
      shell={shell}
      uiDraft={uiDraft}
      uiError={uiError}
    />
  );

  const renderProfile = () => (
    <ProfileSettings profile={profile} shell={shell} />
  );

  const configureDiscovered = async (
    profile: AgentRuntimeCatalog['discovered'][number]['profile'],
  ) => {
    if (!caps.agentRuntime) return;
    setAgentBusy(true);
    try {
      await caps.agentRuntime.upsert(
        {
          id: profile.id,
          label: profile.label,
          provider: profile.provider,
          executable: profile.launch.executable,
          argv: profile.launch.argv,
          shellMode: profile.launch.shellMode,
          cwdPolicy: profile.cwdPolicy,
          backend: profile.backendDefault,
          envelope: profile.bootstrap.envelope,
        },
        true,
      );
      await caps.agentRuntime.setDefault(profile.id, true);
      setAgentMessage(`saved ${profile.label} as default`);
      await reloadAgents();
    } catch (error) {
      setAgentMessage((error as Error).message);
    } finally {
      setAgentBusy(false);
    }
  };

  const verifyAgent = async (profileId: string) => {
    if (!caps.agentRuntime) return;
    setAgentBusy(true);
    try {
      const result = await caps.agentRuntime.verify(profileId);
      setAgentMessage(
        result.ok
          ? `verified ${profileId} · ${result.version ?? 'available'}`
          : `${profileId} unavailable · ${result.error ?? 'version probe failed'}`,
      );
    } catch (error) {
      setAgentMessage((error as Error).message);
    } finally {
      setAgentBusy(false);
    }
  };

  const setDefaultAgent = async (profileId: string) => {
    if (!caps.agentRuntime) return;
    setAgentBusy(true);
    try {
      await caps.agentRuntime.setDefault(profileId, true);
      setAgentMessage(`default launch method: ${profileId}`);
      await reloadAgents();
    } catch (error) {
      setAgentMessage((error as Error).message);
    } finally {
      setAgentBusy(false);
    }
  };

  const removeAgent = async (profileId: string) => {
    if (!caps.agentRuntime) return;
    setAgentBusy(true);
    try {
      await caps.agentRuntime.remove(profileId, true);
      setAgentMessage(`removed ${profileId}`);
      await reloadAgents();
    } catch (error) {
      setAgentMessage((error as Error).message);
    } finally {
      setAgentBusy(false);
    }
  };

  const saveAgentDraft = async () => {
    if (!caps.agentRuntime) return;
    setAgentBusy(true);
    try {
      await caps.agentRuntime.upsert(
        {
          ...agentDraft,
          argv: agentArgv
            .split('\n')
            .map((value) => value.trim())
            .filter(Boolean),
        },
        true,
      );
      await caps.agentRuntime.setDefault(agentDraft.id, true);
      setAgentMessage(`saved ${agentDraft.label} as default`);
      await reloadAgents();
    } catch (error) {
      setAgentMessage((error as Error).message);
    } finally {
      setAgentBusy(false);
    }
  };

  const agentSettingsModel: AgentSettingsModel = {
    agentArgv,
    agentBusy,
    agentCatalog,
    agentDraft,
    agentMessage,
    configureDiscovered,
    reloadAgents,
    removeAgent,
    saveAgentDraft,
    setAgentArgv,
    setAgentDraft,
    setDefaultAgent,
    verifyAgent,
  };

  const renderAgents = () => (
    <AgentSettingsContent
      available={Boolean(caps.agentRuntime)}
      model={agentSettingsModel}
      shell={shell}
    />
  );
  const renderKfx = () => (
    <KfxSettings
      commit={commit}
      declared={declared}
      drafts={drafts}
      setDrafts={setDrafts}
      shell={shell}
    />
  );

  const renderPaths = () => <PathsSettings shell={shell} />;

  const renderAdvanced = () => <AdvancedSettings shell={shell} />;

  return (
    <SettingsTabs
      activeTab={activeTab}
      content={activeSettingsContent(activeTab, {
        advanced: renderAdvanced,
        agents: renderAgents,
        appearance: renderAppearance,
        kfx: renderKfx,
        paths: renderPaths,
        profile: renderProfile,
      })}
      setActiveTab={setActiveTab}
    />
  );
}

export const View = SettingsView;
