import {
  DEFAULT_KUNGFU_ONBOARDING_STATE,
  type KungfuOnboardingState,
  beginKungfuOnboardingRoute,
  dismissKungfuOnboarding,
  finishKungfuOnboarding,
  kungfuAgentBriefCommand,
  kungfuAgentFirstPrompt,
  shouldShowKungfuOnboarding,
} from '@kungfu-tech/api/capability';
import { mono } from '@kungfu-tech/kfx';
import React from 'react';
import {
  ONBOARDING_INSTALL_CLI_CHANNEL,
  ONBOARDING_SET_CHANNEL,
  WINDOW_CHROME_CONTROL_CHANNEL,
  WINDOW_CHROME_GET_CHANNEL,
  WINDOW_CHROME_STATE_CHANNEL,
} from '../../../sandbox/channels';

export type WindowChromeControl = 'minimize' | 'toggle-maximize' | 'close';
export type WindowChromeConfig = {
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  mode: 'native' | 'integrated' | 'custom';
  customControls: boolean;
  draggable: boolean;
  trafficLightInset: number;
  controlInset: number;
  maximized: boolean;
  fullscreen: boolean;
};

const DEFAULT_WINDOW_CHROME: WindowChromeConfig = {
  platform: 'other',
  mode: 'native',
  customControls: false,
  draggable: false,
  trafficLightInset: 0,
  controlInset: 0,
  maximized: false,
  fullscreen: false,
};

function readWindowChromeEnv(): WindowChromeConfig {
  try {
    const raw = window.process?.env?.KF_WINDOW_CHROME;
    return raw
      ? { ...DEFAULT_WINDOW_CHROME, ...JSON.parse(raw) }
      : DEFAULT_WINDOW_CHROME;
  } catch {
    return DEFAULT_WINDOW_CHROME;
  }
}

export function useWindowChrome(): [
  WindowChromeConfig,
  (control: WindowChromeControl) => void,
] {
  const [chrome, setChrome] = React.useState(readWindowChromeEnv);
  React.useEffect(() => {
    type ChromeIpc = {
      invoke: (channel: string, payload?: unknown) => Promise<unknown>;
      on: (
        channel: string,
        listener: (event: unknown, payload: unknown) => void,
      ) => void;
      removeListener: (
        channel: string,
        listener: (event: unknown, payload: unknown) => void,
      ) => void;
    };
    let ipc: ChromeIpc | null = null;
    try {
      ipc = (window.require('electron') as { ipcRenderer: ChromeIpc })
        .ipcRenderer;
    } catch {
      ipc = null;
    }
    if (!ipc) return;
    void ipc.invoke(WINDOW_CHROME_GET_CHANNEL).then((next) => {
      setChrome((current) => ({ ...current, ...(next as object) }));
    });
    const handler = (_event: unknown, payload: unknown) => {
      setChrome((current) => ({ ...current, ...(payload as object) }));
    };
    ipc.on(WINDOW_CHROME_STATE_CHANNEL, handler);
    return () => ipc?.removeListener(WINDOW_CHROME_STATE_CHANNEL, handler);
  }, []);

  const control = React.useCallback((next: WindowChromeControl) => {
    try {
      const ipc = (
        window.require('electron') as {
          ipcRenderer: {
            invoke: (channel: string, payload: unknown) => Promise<unknown>;
          };
        }
      ).ipcRenderer;
      void ipc
        .invoke(WINDOW_CHROME_CONTROL_CHANNEL, { control: next })
        .then((state) =>
          setChrome((current) => ({ ...current, ...(state as object) })),
        );
    } catch {
      // Browser previews have no Electron window to control.
    }
  }, []);
  return [chrome, control];
}

export type AgentFirstEntry = {
  state: KungfuOnboardingState;
  command: string;
  prompt: string;
  cliPath: string;
  cliInstalled: boolean;
};

function initialAgentFirstEntry(): AgentFirstEntry {
  try {
    return JSON.parse(
      window.process.env.KFE_ONBOARDING || '',
    ) as AgentFirstEntry;
  } catch {
    const command = kungfuAgentBriefCommand(
      window.process.env.KUNGFU_CLI_BIN || 'kungfu',
      JSON.parse(window.process.env.KUNGFU_CLI_ARGS_PREFIX || '[]') as string[],
    );
    return {
      state: { ...DEFAULT_KUNGFU_ONBOARDING_STATE },
      command,
      prompt: kungfuAgentFirstPrompt(command),
      cliPath: '',
      cliInstalled: false,
    };
  }
}

export function useAgentFirstEntry() {
  const [entry, setEntry] = React.useState(initialAgentFirstEntry);
  const persist = React.useCallback(async (state: KungfuOnboardingState) => {
    const ipc = (
      window.require('electron') as {
        ipcRenderer: {
          invoke: (channel: string, payload?: unknown) => Promise<unknown>;
        };
      }
    ).ipcRenderer;
    setEntry(
      (await ipc.invoke(ONBOARDING_SET_CHANNEL, { state })) as AgentFirstEntry,
    );
  }, []);
  const installCli = React.useCallback(async () => {
    const ipc = (
      window.require('electron') as {
        ipcRenderer: {
          invoke: (channel: string) => Promise<unknown>;
        };
      }
    ).ipcRenderer;
    const result = (await ipc.invoke(ONBOARDING_INSTALL_CLI_CHANNEL)) as {
      ok: boolean;
      message: string;
      entry: AgentFirstEntry;
    };
    setEntry(result.entry);
    if (!result.ok) throw new Error(result.message);
  }, []);
  return {
    entry,
    initialOpen: shouldShowKungfuOnboarding(entry.state),
    persist,
    installCli,
  };
}

export interface ProductNavigationItem {
  id: string;
  title: string;
  icon: string;
}

export interface ProductNavigationFailure {
  dir: string;
  error: string;
}

interface ProductNavigationProps {
  collapsed: boolean;
  activeViewId?: string;
  labOpen: boolean;
  projectsOpen: boolean;
  publicItems: ProductNavigationItem[];
  advancedItems: ProductNavigationItem[];
  failures: ProductNavigationFailure[];
  onToggle: () => void;
  onOpenView: (id: string) => void;
  onOpenProjects: () => void;
  onOpenLab: () => void;
}

export function ProductNavigation({
  collapsed,
  activeViewId,
  labOpen,
  projectsOpen,
  publicItems,
  advancedItems,
  failures,
  onToggle,
  onOpenView,
  onOpenProjects,
  onOpenLab,
}: ProductNavigationProps) {
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const navStyle = (active: boolean): React.CSSProperties => ({
    ...mono,
    display: 'grid',
    gridTemplateColumns: collapsed ? '1fr' : '18px minmax(0, 1fr)',
    alignItems: 'center',
    columnGap: collapsed ? 0 : 8,
    width: '100%',
    height: 32,
    boxSizing: 'border-box',
    textAlign: collapsed ? 'center' : 'left',
    padding: collapsed ? 0 : '6px 10px',
    border: 'none',
    borderRadius: 5,
    cursor: 'pointer',
    background: active ? '#04395e' : 'transparent',
    color: active ? '#9cdcfe' : '#cccccc',
    overflow: 'hidden',
  });
  const iconStyle: React.CSSProperties = {
    width: 18,
    height: 18,
    lineHeight: '18px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    justifySelf: 'center',
    overflow: 'hidden',
    fontSize: 16,
  };
  const labelStyle: React.CSSProperties = {
    minWidth: 0,
    height: 18,
    lineHeight: '18px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  };
  const button = (
    item: ProductNavigationItem,
    active: boolean,
    onClick: () => void,
  ) => (
    <button
      key={item.id}
      type="button"
      onClick={onClick}
      title={item.title}
      aria-label={item.title}
      aria-current={active ? 'page' : undefined}
      style={navStyle(active)}
    >
      <span aria-hidden="true" style={iconStyle}>
        {item.icon}
      </span>
      {!collapsed && <span style={labelStyle}>{item.title}</span>}
    </button>
  );
  const ordinaryView = !labOpen && !projectsOpen;

  return (
    <nav
      aria-label="Views"
      style={{
        width: collapsed ? 44 : 150,
        flexShrink: 0,
        minHeight: 0,
        overflow: 'auto',
        overflowX: 'hidden',
        transition: 'width 120ms ease',
      }}
    >
      <button
        type="button"
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        onClick={onToggle}
        style={{
          ...mono,
          width: '100%',
          height: 32,
          marginBottom: 8,
          border: '1px solid #3c3c3c',
          borderRadius: 5,
          cursor: 'pointer',
          background: '#252526',
          color: '#cccccc',
          fontSize: 14,
        }}
      >
        {collapsed ? '›' : '‹'}
      </button>
      {publicItems.map((item) =>
        button(item, ordinaryView && activeViewId === item.id, () =>
          onOpenView(item.id),
        ),
      )}
      {button(
        { id: 'projects', title: 'Projects', icon: '◫' },
        projectsOpen,
        onOpenProjects,
      )}
      {button(
        { id: 'agent-work-lab', title: 'Agent Work Lab', icon: '🧪' },
        labOpen,
        onOpenLab,
      )}
      {!collapsed && advancedItems.length > 0 ? (
        <button
          type="button"
          onClick={() => setAdvancedOpen((value) => !value)}
          style={{
            ...mono,
            width: '100%',
            minHeight: 30,
            marginTop: 12,
            border: 'none',
            background: 'transparent',
            color: '#858585',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          {advancedOpen ? '▾' : '▸'} Advanced
        </button>
      ) : null}
      {advancedOpen
        ? advancedItems.map((item) =>
            button(item, ordinaryView && activeViewId === item.id, () =>
              onOpenView(item.id),
            ),
          )
        : null}
      {failures.length > 0 ? (
        <div
          title={failures
            .map((failure) => `${failure.dir}: ${failure.error}`)
            .join('\n')}
          style={{
            ...mono,
            color: '#f48771',
            marginTop: 12,
            fontSize: 10,
            textAlign: collapsed ? 'center' : 'left',
          }}
        >
          {collapsed ? '!' : `${failures.length} kfx failed to load`}
        </div>
      ) : null}
    </nav>
  );
}

const onboardingButtonStyle: React.CSSProperties = {
  ...mono,
  minHeight: 36,
  border: '1px solid #3c3c3c',
  borderRadius: 6,
  padding: '7px 12px',
  cursor: 'pointer',
  background: '#252526',
  color: '#e6edf3',
  textAlign: 'left',
};

export function AgentFirstOnboardingPanel({
  entry,
  onPersist,
  onInstallCli,
  onOpenLab,
  onOpenTour,
  onContinue,
}: {
  entry: AgentFirstEntry;
  onPersist: (state: KungfuOnboardingState) => Promise<void>;
  onInstallCli: () => Promise<void>;
  onOpenLab: () => void;
  onOpenTour: () => void;
  onContinue: () => void;
}) {
  const [notice, setNotice] = React.useState('');
  const persistThen = async (
    state: KungfuOnboardingState,
    next: () => void,
  ) => {
    try {
      await onPersist(state);
      next();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Kungfu could not save your onboarding choice.',
      );
    }
  };
  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(entry.prompt);
      await onPersist(beginKungfuOnboardingRoute(entry.state, 'agent'));
      setNotice('Prompt copied. Paste it into the agent you already use.');
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Kungfu could not copy or save the Agent prompt.',
      );
    }
  };
  return (
    <main
      aria-label="Getting started with Kungfu"
      style={{
        height: '100%',
        overflow: 'auto',
        boxSizing: 'border-box',
        display: 'flex',
        justifyContent: 'center',
        padding: 'clamp(24px, 5vw, 64px)',
        background: '#181818',
        color: '#e6edf3',
      }}
    >
      <section style={{ width: 'min(780px, 100%)' }}>
        <div style={{ ...mono, color: '#4ec9b0', fontSize: 12 }}>
          KUNGFU · AGENT-FIRST ENTRY
        </div>
        <h1 style={{ margin: '10px 0 8px', fontSize: 30 }}>
          Keep your agent. Give it durable Work.
        </h1>
        <p style={{ color: '#b7bec8', lineHeight: 1.55, maxWidth: 690 }}>
          Kungfu does not require a new chat or a new daily workspace. Start by
          teaching Codex, Claude, OpenCode, or Amp how to preserve Projects,
          Work, attempts, review, and settlement across sessions.
        </p>

        <div
          style={{
            marginTop: 20,
            padding: 16,
            border: '1px solid #375a4c',
            borderRadius: 8,
            background: '#15231d',
          }}
        >
          <div style={{ ...mono, color: '#89d6b2', marginBottom: 8 }}>
            1 · COPY THIS TO YOUR EXISTING AGENT
          </div>
          <div
            style={{
              ...mono,
              whiteSpace: 'pre-wrap',
              lineHeight: 1.55,
              color: '#f0f5f2',
            }}
          >
            {entry.prompt}
          </div>
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}
          >
            <button
              type="button"
              onClick={() => void copyPrompt()}
              style={{
                ...onboardingButtonStyle,
                background: '#0e639c',
                color: '#fff',
              }}
            >
              Copy prompt for my Agent
            </button>
            {!entry.cliInstalled ? (
              <button
                type="button"
                onClick={() => {
                  void onInstallCli()
                    .then(() => {
                      setNotice('Kungfu is now available from your PATH.');
                    })
                    .catch((error: unknown) => {
                      setNotice(
                        error instanceof Error
                          ? error.message
                          : 'Kungfu could not be installed in PATH.',
                      );
                    });
                }}
                style={onboardingButtonStyle}
              >
                Install kungfu in PATH
              </button>
            ) : null}
          </div>
          <div
            style={{ ...mono, marginTop: 10, color: '#9aa0a6', fontSize: 12 }}
          >
            Exact local command: {entry.command}
          </div>
          {!entry.cliInstalled ? (
            <div
              style={{ ...mono, marginTop: 4, color: '#dcdcaa', fontSize: 12 }}
            >
              PATH is optional here because the copied prompt includes the exact
              local command.
            </div>
          ) : null}
        </div>

        <div style={{ marginTop: 22 }}>
          <div style={{ ...mono, color: '#9cdcfe', marginBottom: 9 }}>
            OPTIONAL · LEARN WITHOUT LEAVING KUNGFU
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
              gap: 10,
            }}
          >
            <button
              type="button"
              onClick={() => {
                void persistThen(
                  beginKungfuOnboardingRoute(entry.state, 'lab'),
                  onOpenLab,
                );
              }}
              style={onboardingButtonStyle}
            >
              <strong>Agent Work Lab</strong>
              <br />
              <span style={{ color: '#9aa0a6' }}>
                See continuity with a CI-safe Mock Agent.
              </span>
            </button>
            <button
              type="button"
              onClick={() => {
                void persistThen(
                  beginKungfuOnboardingRoute(entry.state, 'tour'),
                  onOpenTour,
                );
              }}
              style={onboardingButtonStyle}
            >
              <strong>Guided Project Tour</strong>
              <br />
              <span style={{ color: '#9aa0a6' }}>
                Create a starter Project and act on real Work.
              </span>
            </button>
          </div>
        </div>

        <p style={{ marginTop: 20, color: '#b7bec8', lineHeight: 1.5 }}>
          You can continue working in your current agent with{' '}
          <code>kungfu run codex|claude|opencode|amp</code>. This GUI and the
          TUI remain optional control and observation surfaces.
        </p>
        {notice ? <output style={{ color: '#4ec9b0' }}>{notice}</output> : null}
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button
            type="button"
            onClick={() => {
              void persistThen(
                finishKungfuOnboarding(entry.state, { route: 'agent' }),
                onContinue,
              );
            }}
            style={{ ...onboardingButtonStyle, background: '#2d5638' }}
          >
            Continue to Work
          </button>
          <button
            type="button"
            onClick={() => {
              void persistThen(
                dismissKungfuOnboarding(entry.state),
                onContinue,
              );
            }}
            style={{ ...onboardingButtonStyle, color: '#9aa0a6' }}
          >
            Don’t show again
          </button>
        </div>
      </section>
    </main>
  );
}
