import * as capability from '@kungfu-tech/api/capability';
import type {
  AgentWorkLabStartupRoute,
  KfxExperienceFlowDescriptor,
  ProductSearchDocument,
  ProductSearchResult,
} from '@kungfu-tech/api/capability';
import * as query from '@kungfu-tech/api/query';
// Reference app shell: boots the in-process runtime and mounts kfx loaded
// from extension packages. The shell owns system concerns only — extension
// scanning and lifecycle, capability injection by declaration, navigation
// with params, the shared refresh bus, shell state (profile / disabled kfx
// and suites / settings, persisted in the runtime home's ConfigStore) and
// the per-kfx error boundary. The shell ships no views of its own: every
// view — including Settings, the kfx manager and Status (the System Suite
// under extensions/system) — is an installable package; the shell keeps
// only a minimal failure surface so a broken install still boots to an
// explanation. See docs/shell-and-kfx.md.
import type {
  KfxCapabilities,
  KfxEntry,
  KungfuConfigValue,
  KungfuResolvedConfig,
  SessionWindowRecord,
  Shell,
  ShellCommand,
  ShellNotification,
  ShellNotificationInput,
  ShellState,
  StatusBarItem,
  StatusBarSeverity,
} from '@kungfu-tech/kfx';
import { mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import type { SessionWindowLaunchAuthorization } from '../../main/session-windows';
import {
  accessibleEntries,
  availableProfiles,
  focusedProfile,
  primaryNavigation,
  productRoleEntry,
  profileHomeId,
} from '../../navigation';
import { isResettableRuntimeFailure } from '../../runtime-recovery-contract';
import {
  type RuntimeStatusResult,
  deriveWorkspaceRuntimePresentation,
} from '../../runtime-status';
import {
  GLOBAL_WORK_OBSERVER_EVENT_CHANNEL,
  GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL,
  GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL,
  RUNTIME_BACKUP_RESET_CHANNEL,
  RUNTIME_STATUS_GET_CHANNEL,
  SESSION_WINDOW_OPEN_CHANNEL,
  SESSION_WINDOW_RESTORE_CHANNEL,
  SESSION_WINDOW_SNAPSHOT_CHANNEL,
  SHELL_NAVIGATE_CHANNEL,
  SHELL_REFRESH_CHANNEL,
  type ShellNavigateRequest,
  WINDOW_CHROME_CONTROL_CHANNEL,
  WINDOW_CHROME_GET_CHANNEL,
  WINDOW_CHROME_STATE_CHANNEL,
  WORKSPACE_GET_CHANNEL,
  WORKSPACE_OPEN_CHANNEL,
  WORKSPACE_SELECT_HOME_CHANNEL,
  WORKSPACE_SELECT_RECENT_CHANNEL,
  WORKSPACE_START_CONTINUATION_CHANNEL,
} from '../../sandbox/channels';
import { publishRefresh } from '../../sandbox/refresh';
import { createKfxSharedModules } from '../shared-modules';
import { AgentWorkLabPanel } from './agent-work-lab';
import {
  loadKungfuConfig,
  normalizedUiConfig,
  resolvedMonoFontFamily,
  resolvedUiFontFamily,
  setKungfuConfigValue,
  unsetKungfuConfigValue,
} from './gui-config';
import { type KfxLoadResult, loadKfx } from './kfx-loader';
import {
  type Runtime,
  bootRuntime,
  deferredRuntime,
  openRendererAgentWorkLab,
} from './runtime';
import { sandboxClient } from './sandbox-client';
import { DEFAULT_STATE, loadShellState, saveShellState } from './shell-state';

// Modules injected into every kfx bundle (the externals contract of
// `kungfu sdk kfx build`): one React instance and the public API surfaces.
const SHARED_MODULES = createKfxSharedModules({
  react: React,
  jsxRuntime,
  reactDom: ReactDOM,
  reactDomClient: { createRoot },
  api: capability,
  capability,
  query,
});

// One failing kfx renders its error panel; it never takes the shell down.
class KfxErrorBoundary extends React.Component<
  { kfxId: string; children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { kfxId: string }) {
    if (prev.kfxId !== this.props.kfxId && this.state.error) {
      this.setState({ error: null });
    }
  }
  render() {
    if (this.state.error) {
      return (
        <section style={panelStyle}>
          <div style={{ ...mono, color: '#f48771' }}>
            kfx `{this.props.kfxId}` failed: {this.state.error.message}
          </div>
          <div style={{ ...mono, color: '#6a6a6a', marginTop: 4 }}>
            the shell and other kfx keep running — see the console for the stack
          </div>
        </section>
      );
    }
    return this.props.children;
  }
}

function subsetCaps(runtime: Runtime, entry: KfxEntry): KfxCapabilities | null {
  const full = {
    ledger: runtime.ledger,
    domain: runtime.domain,
    rewind: runtime.rewind,
    storage: runtime.storage,
    terminal: runtime.terminal,
    work: runtime.work,
    workLoop: runtime.workLoop,
    kfxControl: runtime.kfxControl,
    profile: runtime.profile,
    agentRuntime: runtime.agentRuntime,
    agentSession: runtime.agentSession,
    agentWorkLab: runtime.agentWorkLab,
    workspace: runtime.workspace,
  } as Record<string, unknown>;
  const subset: Record<string, unknown> = {};
  for (const key of entry.capabilities) {
    if (!full[key]) return null;
    subset[key] = full[key];
  }
  // only declared handles are populated; undeclared access is a kfx bug the
  // error boundary contains
  return subset as unknown as KfxCapabilities;
}

// The declared capability handles the trusted renderer holds for a sandboxed
// view. Unlike subsetCaps this never returns null: a missing handle is simply
// absent, and the trusted host rejects a call to it — the sandboxed view has no
// direct handle to fault on. These stay in this (trusted) renderer; only invoke
// results cross to the isolated view.
function sandboxSubset(
  runtime: Runtime,
  entry: KfxEntry,
): Record<string, Record<string, unknown>> {
  const full: Record<string, unknown> = {
    ledger: runtime.ledger,
    domain: runtime.domain,
    rewind: runtime.rewind,
    storage: runtime.storage,
    terminal: runtime.terminal,
    work: runtime.work,
    workLoop: runtime.workLoop,
    kfxControl: runtime.kfxControl,
    profile: runtime.profile,
    agentRuntime: runtime.agentRuntime,
    agentSession: runtime.agentSession,
    agentWorkLab: runtime.agentWorkLab,
    workspace: runtime.workspace,
  };
  const subset: Record<string, Record<string, unknown>> = {};
  for (const key of entry.capabilities) {
    const handle = full[key];
    if (handle) subset[key] = handle as Record<string, unknown>;
  }
  return subset;
}

// A sandboxed-ipc view is not mounted in this renderer. The shell registers its
// trusted capability host, asks main to embed the isolated WebContentsView, and
// keeps the overlay positioned over this slot's content rect. The slot itself is
// an empty box; the view renders in its own process, layered above.
function SandboxSlot({
  entry,
  caps,
}: {
  entry: KfxEntry;
  caps: Record<string, Record<string, unknown>>;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  // caps identity is stable for a given runtime and entry.capabilities is a
  // property of the same entry; re-embedding keys only on the view identity.
  // biome-ignore lint/correctness/useExhaustiveDependencies: caps/entry.capabilities are stable per active view; re-embed keys on id + bundlePath only
  React.useEffect(() => {
    const id = entry.id;
    const sync = () => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      sandboxClient.setBounds(id, {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      });
    };
    sandboxClient.registerHost(id, caps, entry.capabilities);
    let cancelled = false;
    void sandboxClient
      .ensure(id, {
        bundlePath: entry.bundlePath,
        declared: entry.capabilities,
      })
      .then(() => {
        if (cancelled) return;
        sync();
        sandboxClient.show(id);
      });
    const ro = new ResizeObserver(sync);
    if (ref.current) ro.observe(ref.current);
    window.addEventListener('resize', sync);
    return () => {
      cancelled = true;
      ro.disconnect();
      window.removeEventListener('resize', sync);
      sandboxClient.destroy(id);
      sandboxClient.disposeHost(id);
    };
    // re-embed only when the active sandboxed view changes; caps identity is
    // stable for a given runtime
  }, [entry.id, entry.bundlePath]);
  return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
}

function statusColor(severity: StatusBarSeverity | undefined): string {
  if (severity === 'ok') return '#4ec9b0';
  if (severity === 'warning') return '#dcdcaa';
  if (severity === 'error') return '#f48771';
  return '#cccccc';
}

function trustStatusText(status: RuntimeStatusResult | null): string {
  const assessments = status?.payload?.assessments;
  if (!assessments) return 'trust unavailable';
  const counts = assessments.counts ?? {};
  const blocked =
    (counts.stale ?? 0) +
    (counts['insufficient-evidence'] ?? 0) +
    (counts.conflicted ?? 0) +
    (counts.unverifiable ?? 0) +
    (counts['failed-retryable'] ?? 0);
  if (blocked > 0) return `trust blocked ${String(blocked)}`;
  if ((counts.pending ?? 0) + (counts.running ?? 0) > 0)
    return `trust pending ${String((counts.pending ?? 0) + (counts.running ?? 0))}`;
  return `trust fresh ${String(counts.fresh ?? 0)}`;
}

function trustTooltip(status: RuntimeStatusResult | null): string {
  const assessments = status?.payload?.assessments?.assessments;
  if (!assessments) return 'Assessment subscription is unavailable';
  if (assessments.length === 0) return 'No load-bearing claims assessed';
  return assessments
    .map((assessment) => {
      const request = assessment.request ?? {};
      const risks = assessment.report?.residual_risks?.join('; ') || '-';
      return `${assessment.state || '-'}: ${request.claim_id || '-'} for ${
        request.purpose || '-'
      }\nresidual risk: ${risks}\nproof: ${
        assessment.report?.query_proof_root || '-'
      }`;
    })
    .join('\n\n');
}

function notificationColor(level: ShellNotification['level']): string {
  if (level === 'success') return '#4ec9b0';
  if (level === 'warning') return '#dcdcaa';
  if (level === 'error') return '#f48771';
  return '#9cdcfe';
}

let notificationSeq = 0;
function notificationId(): string {
  notificationSeq += 1;
  return (
    globalThis.crypto?.randomUUID?.() ?? `n-${Date.now()}-${notificationSeq}`
  );
}

type WindowChromeControl = 'minimize' | 'toggle-maximize' | 'close';
type WindowChromeConfig = {
  platform: 'darwin' | 'win32' | 'linux' | 'other';
  mode: 'native' | 'integrated' | 'custom';
  customControls: boolean;
  draggable: boolean;
  trafficLightInset: number;
  controlInset: number;
  maximized: boolean;
  fullscreen: boolean;
};
type ElectronChromeStyle = React.CSSProperties & {
  WebkitAppRegion?: 'drag' | 'no-drag';
};

const defaultWindowChrome: WindowChromeConfig = {
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
    if (!raw) return defaultWindowChrome;
    return { ...defaultWindowChrome, ...JSON.parse(raw) };
  } catch {
    return defaultWindowChrome;
  }
}

function useWindowChrome(): [
  WindowChromeConfig,
  (control: WindowChromeControl) => void,
] {
  const [chrome, setChrome] =
    React.useState<WindowChromeConfig>(readWindowChromeEnv);
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

function ShellTitleBar({
  chrome,
  activeTitle,
  searchText,
  searchResults,
  searchStatus,
  settingsOpen,
  workspaceLabel,
  onSearchChange,
  onSearchActivate,
  onOpenSettings,
  onOpenWorkspace,
  onWindowControl,
}: {
  chrome: WindowChromeConfig;
  activeTitle: string;
  searchText: string;
  searchResults: ProductSearchResult[];
  searchStatus: string;
  settingsOpen: boolean;
  workspaceLabel: string;
  onSearchChange: (value: string) => void;
  onSearchActivate: (result: ProductSearchResult) => void;
  onOpenSettings: () => void;
  onOpenWorkspace: () => void;
  onWindowControl: (control: WindowChromeControl) => void;
}) {
  const searchRoot = React.useRef<HTMLFormElement>(null);
  const searchInput = React.useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [selectedSearchResult, setSelectedSearchResult] = React.useState(0);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        searchInput.current?.focus();
        searchInput.current?.select();
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        searchRoot.current &&
        !searchRoot.current.contains(target)
      ) {
        setSearchOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, []);
  const activateSearchResult = (index = selectedSearchResult) => {
    const result = searchResults[index];
    if (!result) return;
    onSearchActivate(result);
    setSearchOpen(false);
  };
  const dragRegion: ElectronChromeStyle = {
    WebkitAppRegion: chrome.draggable ? 'drag' : undefined,
  };
  const interactiveRegion: ElectronChromeStyle = {
    WebkitAppRegion: 'no-drag',
  };
  const leftInset =
    chrome.mode === 'integrated' ? Math.max(84, chrome.trafficLightInset) : 12;
  const rightInset = chrome.customControls
    ? Math.max(138, chrome.controlInset)
    : 12;
  const controlButton = (
    control: WindowChromeControl,
    label: string,
    ariaLabel: string,
    danger = false,
  ) => (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={() => onWindowControl(control)}
      style={{
        ...interactiveRegion,
        width: 46,
        height: 34,
        border: 'none',
        borderRadius: 0,
        cursor: 'pointer',
        background: 'transparent',
        color: danger ? '#ffffff' : '#cccccc',
        fontSize: 14,
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = danger ? '#c42b1c' : '#343434';
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = 'transparent';
      }}
    >
      {label}
    </button>
  );

  return (
    <header
      style={{
        ...dragRegion,
        position: 'relative',
        zIndex: 100,
        height: 42,
        flexShrink: 0,
        display: 'grid',
        gridTemplateColumns: `${leftInset}px minmax(160px, 1fr) auto ${rightInset}px`,
        alignItems: 'center',
        background: '#1e1e1e',
        borderBottom: '1px solid #2d2d2d',
        userSelect: 'none',
      }}
    >
      <div />
      <div
        style={{
          minWidth: 0,
          display: 'grid',
          gridTemplateColumns: 'minmax(120px, 220px) minmax(180px, 520px)',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <div
          title={activeTitle}
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: 12,
            color: '#9cdcfe',
            fontWeight: 600,
          }}
        >
          Kungfu Episodes
        </div>
        <form
          ref={searchRoot}
          onSubmit={(event) => {
            event.preventDefault();
            activateSearchResult();
          }}
          style={{
            ...interactiveRegion,
            position: 'relative',
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            zIndex: 50,
          }}
        >
          <input
            ref={searchInput}
            aria-label="Search Kungfu"
            value={searchText}
            onFocus={() => setSearchOpen(true)}
            onChange={(event) => {
              setSelectedSearchResult(0);
              onSearchChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setSelectedSearchResult(
                  (current) =>
                    (current + 1) % Math.max(1, searchResults.length),
                );
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setSelectedSearchResult(
                  (current) =>
                    (current - 1 + Math.max(1, searchResults.length)) %
                    Math.max(1, searchResults.length),
                );
              } else if (event.key === 'Escape') {
                event.preventDefault();
                setSearchOpen(false);
                searchInput.current?.blur();
              }
            }}
            placeholder="Search Help, Commands, Work"
            style={{
              width: '100%',
              height: 26,
              border: '1px solid #3c3c3c',
              borderRadius: 6,
              boxSizing: 'border-box',
              background: '#252526',
              color: '#cccccc',
              padding: '0 10px',
              outline: 'none',
              fontSize: 12,
            }}
          />
          {searchOpen ? (
            <section
              aria-label="Kungfu search results"
              style={{
                position: 'absolute',
                top: 30,
                left: 0,
                width: '100%',
                maxHeight: 360,
                overflow: 'auto',
                boxSizing: 'border-box',
                border: '1px solid #454545',
                borderRadius: 6,
                background: '#181818',
                boxShadow: '0 12px 28px rgba(0, 0, 0, 0.55)',
                padding: 5,
              }}
            >
              <div
                style={{
                  ...mono,
                  color: '#858585',
                  padding: '3px 7px 6px',
                  fontSize: 11,
                }}
              >
                {searchStatus} · ↑↓ choose · Enter open
              </div>
              {searchResults.length === 0 ? (
                <div style={{ ...mono, color: '#dcdcaa', padding: 8 }}>
                  No matching Help, Command, Work, or view.
                </div>
              ) : null}
              {searchResults.map((result, index) => (
                <button
                  key={result.id}
                  type="button"
                  aria-pressed={index === selectedSearchResult}
                  onMouseEnter={() => setSelectedSearchResult(index)}
                  onClick={() => activateSearchResult(index)}
                  style={{
                    ...mono,
                    width: '100%',
                    display: 'grid',
                    gridTemplateColumns: '68px minmax(0, 1fr)',
                    gap: 7,
                    padding: '6px 7px',
                    border: 'none',
                    borderRadius: 4,
                    cursor: 'pointer',
                    textAlign: 'left',
                    color: '#cccccc',
                    background:
                      index === selectedSearchResult
                        ? '#04395e'
                        : 'transparent',
                  }}
                >
                  <span
                    style={{
                      color:
                        result.kind === 'work'
                          ? '#4ec9b0'
                          : result.kind === 'command'
                            ? '#dcdcaa'
                            : result.kind === 'view'
                              ? '#c586c0'
                              : '#9cdcfe',
                      fontSize: 10,
                      textTransform: 'uppercase',
                    }}
                  >
                    {result.kind}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {result.title}
                    </span>
                    <span
                      style={{
                        display: 'block',
                        color: '#858585',
                        fontSize: 11,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {result.summary}
                    </span>
                  </span>
                </button>
              ))}
            </section>
          ) : null}
        </form>
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 6,
          paddingRight: 8,
        }}
      >
        <button
          type="button"
          aria-label="Open workspace switcher"
          title={workspaceLabel}
          onClick={onOpenWorkspace}
          style={{
            ...interactiveRegion,
            ...mono,
            maxWidth: 180,
            height: 28,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            border: '1px solid #3c3c3c',
            borderRadius: 6,
            cursor: 'pointer',
            background: '#252526',
            color: '#9cdcfe',
            padding: '0 8px',
          }}
        >
          {workspaceLabel}
        </button>
        <button
          type="button"
          aria-label="Open settings"
          onClick={onOpenSettings}
          style={{
            ...interactiveRegion,
            ...mono,
            width: 30,
            height: 28,
            border: '1px solid #3c3c3c',
            borderRadius: 6,
            cursor: 'pointer',
            background: settingsOpen ? '#04395e' : '#252526',
            color: settingsOpen ? '#9cdcfe' : '#cccccc',
            fontSize: 16,
            lineHeight: '24px',
          }}
        >
          ⚙
        </button>
      </div>
      <div
        style={{
          ...interactiveRegion,
          height: '100%',
          display: chrome.customControls ? 'flex' : 'none',
          alignItems: 'stretch',
          justifyContent: 'flex-end',
        }}
      >
        {controlButton('minimize', '—', 'Minimize window')}
        {controlButton(
          'toggle-maximize',
          chrome.maximized ? '❐' : '□',
          chrome.maximized ? 'Restore window' : 'Maximize window',
        )}
        {controlButton('close', '×', 'Close window', true)}
      </div>
    </header>
  );
}

type WorkspaceSnapshot = {
  current: {
    workspaceId: string;
    workspaceKind: 'home' | 'project';
    workspaceRoot: string | null;
    displayPath: string;
    dataHome: string;
    state:
      | 'uninitialized'
      | 'shadow-only'
      | 'live-runtime'
      | 'evidence-degraded'
      | 'unavailable';
    diagnosis: string;
    evidenceLevel: 'none' | 'settled-review' | 'live-local' | 'degraded';
    settledEpisodeCount: number;
    projectCutCount: number;
  };
  recent: Array<{
    workspace_id?: string;
    workspace_kind?: 'home' | 'project';
    workspace_root?: string | null;
    display_path?: string;
    data_home?: string;
  }>;
};

function workspaceIpc() {
  const ipcRenderer = (
    window.require('electron') as {
      ipcRenderer: {
        invoke: (channel: string, payload?: unknown) => Promise<unknown>;
      };
    }
  ).ipcRenderer;
  return {
    get: () =>
      ipcRenderer.invoke(WORKSPACE_GET_CHANNEL) as Promise<WorkspaceSnapshot>,
    open: () => ipcRenderer.invoke(WORKSPACE_OPEN_CHANNEL),
    home: () => ipcRenderer.invoke(WORKSPACE_SELECT_HOME_CHANNEL),
    startContinuation: () =>
      ipcRenderer.invoke(WORKSPACE_START_CONTINUATION_CHANNEL),
    recent: (workspaceId: string) =>
      ipcRenderer.invoke(WORKSPACE_SELECT_RECENT_CHANNEL, { workspaceId }),
  };
}

function WorkspacePanel() {
  const bridge = React.useMemo(workspaceIpc, []);
  const [snapshot, setSnapshot] = React.useState<WorkspaceSnapshot | null>(
    null,
  );
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => {
    void bridge
      .get()
      .then(setSnapshot)
      .catch((e) => setError((e as Error).message));
  }, [bridge]);
  const run = (action: () => Promise<unknown>) => {
    setError(null);
    void action().catch((e) => setError((e as Error).message));
  };
  return (
    <section style={{ ...panelStyle, width: 'min(680px, 100%)' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Workspace</h2>
      {snapshot && (
        <div style={{ ...mono, color: '#9cdcfe', marginBottom: 10 }}>
          {snapshot.current.displayPath} · {snapshot.current.state}
          {snapshot.current.diagnosis ? ` · ${snapshot.current.diagnosis}` : ''}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => run(bridge.open)}
          style={{ ...mono, padding: '6px 10px' }}
        >
          Open Workspace…
        </button>
        <button
          type="button"
          onClick={() => run(bridge.home)}
          style={{ ...mono, padding: '6px 10px' }}
        >
          Use Home Workspace
        </button>
      </div>
      <div style={{ ...mono, color: '#858585', marginBottom: 6 }}>
        Opening or selecting is read-only. The first fact-bearing action creates
        the selected `.kungfu` data home.
      </div>
      {snapshot?.current.state === 'shadow-only' && (
        <div
          style={{
            display: 'grid',
            gap: 5,
            padding: 8,
            marginBottom: 10,
            border: '1px solid #3c3c3c',
            borderRadius: 5,
          }}
        >
          <div style={{ ...mono, color: '#9cdcfe' }}>
            Settled history is available without a local runtime.
          </div>
          <div style={{ ...mono, color: '#858585' }}>
            {snapshot.current.settledEpisodeCount} Episode shadow(s) ·{' '}
            {snapshot.current.projectCutCount} Project Cut(s) · evidence{' '}
            {snapshot.current.evidenceLevel}. Git shadows are not Episode
            authority; raw replay and requalification require full evidence.
          </div>
          <button
            type="button"
            onClick={() => run(bridge.startContinuation)}
            style={{ ...mono, padding: '6px 10px', width: 'fit-content' }}
          >
            Start local continuation
          </button>
        </div>
      )}
      {snapshot?.current.state === 'evidence-degraded' && (
        <div style={{ ...mono, color: '#f48771', marginBottom: 10 }}>
          Settled evidence is degraded. Continuation is disabled until the
          reported shadow mismatch is repaired or full evidence is imported.
        </div>
      )}
      {snapshot?.current.state === 'uninitialized' && (
        <div
          style={{
            display: 'grid',
            gap: 5,
            padding: 8,
            marginBottom: 10,
            border: '1px solid #3c3c3c',
            borderRadius: 5,
          }}
        >
          <div style={{ ...mono, color: '#9cdcfe' }}>
            This Workspace has not been initialized yet.
          </div>
          <div style={{ ...mono, color: '#858585' }}>
            Open the focused Profile and run its first fact-bearing action when
            you are ready.
          </div>
        </div>
      )}
      {snapshot?.recent.map((recent) => (
        <button
          key={recent.workspace_id}
          type="button"
          disabled={
            recent.workspace_kind === 'project' && !recent.workspace_root
          }
          onClick={() =>
            recent.workspace_id &&
            run(() => bridge.recent(recent.workspace_id as string))
          }
          style={{
            ...mono,
            display: 'block',
            width: '100%',
            padding: '5px 7px',
            border: 'none',
            background: 'transparent',
            color: '#cccccc',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          {recent.display_path || recent.workspace_root || 'Home Workspace'}
        </button>
      ))}
      {error && <div style={{ ...mono, color: '#f48771' }}>{error}</div>}
    </section>
  );
}

function RuntimeFailurePanel({ message }: { message: string }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const resettable = isResettableRuntimeFailure(message);
  const backupAndReset = () => {
    setBusy(true);
    setError('');
    const ipcRenderer = (
      window.require('electron') as {
        ipcRenderer: {
          invoke: (
            channel: string,
            payload: unknown,
          ) => Promise<{ ok?: boolean; canceled?: boolean; error?: string }>;
        };
      }
    ).ipcRenderer;
    void ipcRenderer
      .invoke(RUNTIME_BACKUP_RESET_CHANNEL, { message })
      .then((result) => {
        if (!result.ok && !result.canceled) {
          setError(result.error || 'runtime recovery failed');
        }
      })
      .catch((reason) => setError((reason as Error).message))
      .finally(() => setBusy(false));
  };
  return (
    <section style={{ ...panelStyle, width: 'min(680px, 100%)' }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>
        Workspace runtime unavailable
      </h2>
      <pre
        style={{
          ...mono,
          color: '#f48771',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
        }}
      >
        {message || 'Unknown runtime startup failure'}
      </pre>
      {resettable && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={backupAndReset}
            style={{ ...mono, padding: '6px 10px' }}
          >
            {busy ? 'Preparing recovery…' : 'Back up and reset runtime'}
          </button>
          <div style={{ ...mono, color: '#858585', marginTop: 8 }}>
            The current runtime is preserved under
            .kungfu/backups/runtime-recovery before Kungfu creates a fresh one.
          </div>
        </>
      )}
      {error && <div style={{ ...mono, color: '#f48771' }}>{error}</div>}
    </section>
  );
}

function App() {
  const [agentWorkLab] = React.useState(openRendererAgentWorkLab);
  const [startup] = React.useState<AgentWorkLabStartupRoute>(() => {
    try {
      return agentWorkLab.inspectSync();
    } catch (error) {
      return {
        schema: 'kungfu.agent-work-lab.startup-route/v1',
        state: 'diagnostic',
        route: 'diagnostic',
        reasonCode: 'startup-inspection-failed',
        message: error instanceof Error ? error.message : String(error),
        runtimeDir: window.process.env.KF_RUNTIME_DIR || '',
        workGraphPresent: null,
        evidence: [],
        writeOccurred: false,
      };
    }
  });
  const startupSurface = capability.agentWorkLabStartupSurface(startup);
  const [runtime] = React.useState(() =>
    startupSurface === 'work-graph'
      ? bootRuntime()
      : deferredRuntime(
          agentWorkLab,
          `startup routed to ${startup.route}: ${startup.reasonCode}`,
        ),
  );
  const [labOpen, setLabOpen] = React.useState(
    startupSurface === 'agent-work-lab',
  );
  const [kfxDescriptor] = React.useState<KfxExperienceFlowDescriptor | null>(
    () => {
      try {
        const plan = runtime.storage?.kfxRegistry('plan', {});
        return (
          (plan?.hostContract as unknown as KfxExperienceFlowDescriptor) ?? null
        );
      } catch {
        return null;
      }
    },
  );
  const [loaded] = React.useState<KfxLoadResult>(() =>
    loadKfx(window.process.env, SHARED_MODULES, kfxDescriptor),
  );
  const [state, setState] = React.useState<ShellState>(() =>
    runtime.domain ? loadShellState(runtime.domain) : DEFAULT_STATE,
  );
  const profiles = React.useMemo(
    () => availableProfiles(loaded.profiles),
    [loaded.profiles],
  );
  const profile = focusedProfile(
    profiles,
    state.profileId,
    window.process.env.KFE_DEFAULT_PROFILE,
  );
  const enabled = React.useMemo(
    () => accessibleEntries(loaded.entries, state),
    [loaded.entries, state],
  );
  const [active, setActive] = React.useState(
    () =>
      window.process.env.KFE_INITIAL_VIEW || profileHomeId(profile, enabled),
  );
  const [params, setParams] = React.useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [searchText, setSearchText] = React.useState('');
  const [cliSearchDocuments, setCliSearchDocuments] = React.useState<
    ProductSearchDocument[]
  >([]);
  const [workSearchDocuments, setWorkSearchDocuments] = React.useState<
    ProductSearchDocument[]
  >([]);
  const [globalWorkSearchDocuments, setGlobalWorkSearchDocuments] =
    React.useState<ProductSearchDocument[]>([]);
  const [searchCatalogStatus, setSearchCatalogStatus] = React.useState(
    'Loading governed command catalog',
  );
  const [windowChrome, controlWindow] = useWindowChrome();
  const [config, setConfig] = React.useState<KungfuResolvedConfig | null>(null);
  const [configError, setConfigError] = React.useState('');
  const [runtimeStatus, setRuntimeStatus] =
    React.useState<RuntimeStatusResult | null>(null);
  const [statusBarItems, setStatusBarItems] = React.useState<
    Record<string, StatusBarItem>
  >({});
  const [notifications, setNotifications] = React.useState<ShellNotification[]>(
    [],
  );
  const notificationTimers = React.useRef(new Map<string, number>());
  const startupViewApplied = React.useRef(false);

  React.useEffect(() => {
    if (startupViewApplied.current || !config) return;
    startupViewApplied.current = true;
    const agent = config.config.agent as
      | { startupView?: 'profile-home' | 'agent-console' }
      | undefined;
    const consoleEntry = productRoleEntry(enabled, 'agent-console');
    if (
      !window.process.env.KFE_INITIAL_VIEW &&
      agent?.startupView === 'agent-console' &&
      consoleEntry
    ) {
      setActive(consoleEntry.id);
    }
  }, [config, enabled]);

  React.useEffect(() => {
    type ExecFile = (
      file: string,
      args: string[],
      options: {
        encoding: 'utf8';
        env: Record<string, string | undefined>;
        maxBuffer: number;
      },
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => void;
    const { execFile } = window.require('node:child_process') as {
      execFile: ExecFile;
    };
    const env: Record<string, string | undefined> = {
      ...window.process.env,
      KUNGFU_AS_VARIANT: undefined,
    };
    let active = true;
    void capability
      .loadCliHelpSearchDocuments({
        bin:
          env.KUNGFU_CLI_BIN ||
          env.KUNGFU_BIN ||
          (window.process.platform === 'win32' ? 'kungfu.exe' : 'kungfu'),
        env,
        execFile: (file, args, options) =>
          new Promise<string>((resolve, reject) => {
            execFile(file, args, options, (error, stdout, stderr) => {
              if (error) {
                reject(new Error(stderr.trim() || error.message));
              } else {
                resolve(stdout);
              }
            });
          }),
      })
      .then((documents) => {
        if (!active) return;
        setCliSearchDocuments(documents);
        setSearchCatalogStatus(
          `${documents.length} governed Help and Command entries`,
        );
      })
      .catch((error) => {
        if (!active) return;
        setSearchCatalogStatus(
          `Command catalog unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return () => {
      active = false;
    };
  }, []);

  React.useEffect(() => {
    type GlobalWorkObserverEvent =
      | {
          schema: 'kungfu.gui.global-work-observer-event/v1';
          kind: 'snapshot';
          snapshot: Record<string, unknown>;
        }
      | {
          schema: 'kungfu.gui.global-work-observer-event/v1';
          kind: 'error';
          error: string;
        };
    type GlobalWorkIpc = {
      invoke: (channel: string) => Promise<unknown>;
      on: (
        channel: string,
        listener: (event: unknown, payload: GlobalWorkObserverEvent) => void,
      ) => void;
      removeListener: (
        channel: string,
        listener: (event: unknown, payload: GlobalWorkObserverEvent) => void,
      ) => void;
    };
    let ipc: GlobalWorkIpc | null = null;
    try {
      ipc = (window.require('electron') as { ipcRenderer: GlobalWorkIpc })
        .ipcRenderer;
    } catch {
      ipc = null;
    }
    if (!ipc) return;
    const receive = (_event: unknown, payload: GlobalWorkObserverEvent) => {
      if (
        payload?.schema !== 'kungfu.gui.global-work-observer-event/v1' ||
        payload.kind !== 'snapshot'
      ) {
        return;
      }
      try {
        setGlobalWorkSearchDocuments(
          capability.globalWorkSearchDocuments(
            capability.parseGlobalWorkSnapshot(payload.snapshot),
          ),
        );
      } catch {
        // Keep the last verified search projection during observer recovery.
      }
    };
    ipc.on(GLOBAL_WORK_OBSERVER_EVENT_CHANNEL, receive);
    void ipc.invoke(GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL);
    return () => {
      ipc?.removeListener(GLOBAL_WORK_OBSERVER_EVENT_CHANNEL, receive);
      void ipc?.invoke(GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL);
    };
  }, []);

  // shared refresh bus: one shell-owned timer, kfx subscribe
  const subscribers = React.useRef(new Set<() => void>());
  const refreshProductData = React.useCallback(() => {
    publishRefresh(subscribers.current, (error) => {
      console.error('[shell] product data refresh failed', error);
    });
  }, []);
  React.useEffect(() => {
    const timer = setInterval(refreshProductData, 5000);
    return () => clearInterval(timer);
  }, [refreshProductData]);

  React.useEffect(() => {
    type RefreshIpc = {
      on: (channel: string, handler: () => void) => void;
      removeListener: (channel: string, handler: () => void) => void;
    };
    let ipc: RefreshIpc | null = null;
    try {
      ipc = (window.require('electron') as { ipcRenderer: RefreshIpc })
        .ipcRenderer;
    } catch {
      ipc = null;
    }
    if (!ipc) return;
    ipc.on(SHELL_REFRESH_CHANNEL, refreshProductData);
    return () => ipc?.removeListener(SHELL_REFRESH_CHANNEL, refreshProductData);
  }, [refreshProductData]);

  React.useEffect(() => {
    if (!runtime.ok) return;
    type RuntimeStatusIpc = {
      invoke: (channel: string) => Promise<RuntimeStatusResult>;
    };
    let ipc: RuntimeStatusIpc | null = null;
    try {
      ipc = (window.require('electron') as { ipcRenderer: RuntimeStatusIpc })
        .ipcRenderer;
    } catch {
      ipc = null;
    }
    if (!ipc) return;
    let cancelled = false;
    const refresh = () => {
      void ipc
        .invoke(RUNTIME_STATUS_GET_CHANNEL)
        .then((next) => {
          if (!cancelled) setRuntimeStatus(next);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setRuntimeStatus({
            ok: false,
            payload: null,
            error: e instanceof Error ? e.message : String(e),
            updatedAt: Date.now(),
          });
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [runtime.ok]);

  React.useEffect(() => {
    if (!runtime.work) {
      setWorkSearchDocuments([]);
      return;
    }
    const refresh = () => {
      try {
        runtime.work?.refresh();
        setWorkSearchDocuments(
          (runtime.work?.items() ?? []).map((item, index) => ({
            id: `work.${item.workId}`,
            kind: 'work',
            title: item.title || item.workId,
            summary:
              [item.summary, item.nextAction && `Next: ${item.nextAction}`]
                .filter(Boolean)
                .join(' · ') || 'Current Work information.',
            keywords: [item.workId, item.kind || '', item.nextAction || ''],
            priority: index,
            action: { kind: 'open-work', workId: item.workId },
          })),
        );
      } catch {
        setWorkSearchDocuments([]);
      }
    };
    refresh();
    subscribers.current.add(refresh);
    return () => {
      subscribers.current.delete(refresh);
    };
  }, [runtime.work]);

  React.useEffect(
    () => () => {
      for (const timer of notificationTimers.current.values()) {
        window.clearTimeout(timer);
      }
      notificationTimers.current.clear();
    },
    [],
  );

  const openKfx = React.useCallback(
    (kfxId: string, nextParams?: Record<string, string>) => {
      setLabOpen(false);
      setParams(nextParams ?? {});
      setActive(kfxId);
    },
    [],
  );

  const updateState = React.useCallback(
    (patch: Partial<ShellState>) => {
      const requestedProfile = patch.profileId
        ? focusedProfile(profiles, patch.profileId)
        : null;
      if (requestedProfile) {
        setParams({});
        setActive(profileHomeId(requestedProfile, enabled));
      }
      setState((current) => {
        const next = {
          ...current,
          ...patch,
          ...(requestedProfile ? { profileId: requestedProfile.id } : {}),
        };
        if (runtime.domain) saveShellState(runtime.domain, next);
        return next;
      });
    },
    [enabled, profiles, runtime.domain],
  );

  React.useEffect(() => {
    if (state.profileId !== profile.id) {
      updateState({ profileId: profile.id });
    }
  }, [profile.id, state.profileId, updateState]);

  React.useEffect(() => {
    type NavigationIpc = {
      on: (
        channel: string,
        handler: (event: unknown, request: ShellNavigateRequest) => void,
      ) => void;
      removeListener: (
        channel: string,
        handler: (event: unknown, request: ShellNavigateRequest) => void,
      ) => void;
    };
    let ipc: NavigationIpc | null = null;
    try {
      ipc = (window.require('electron') as { ipcRenderer: NavigationIpc })
        .ipcRenderer;
    } catch {
      ipc = null;
    }
    if (!ipc) return;
    const navigate = (_event: unknown, request: ShellNavigateRequest) => {
      if (request.target === 'settings') {
        setSettingsOpen(true);
      } else if (request.target === 'profile-home') {
        openKfx(profileHomeId(profile, enabled));
      } else if (request.target === 'view') {
        openKfx(request.kfxId);
      }
    };
    ipc.on(SHELL_NAVIGATE_CHANNEL, navigate);
    return () => ipc?.removeListener(SHELL_NAVIGATE_CHANNEL, navigate);
  }, [enabled, openKfx, profile]);

  const reloadConfig = React.useCallback(() => {
    try {
      setConfig(loadKungfuConfig());
      setConfigError('');
    } catch (e) {
      setConfig(null);
      setConfigError((e as Error).message);
    }
  }, []);

  React.useEffect(() => {
    reloadConfig();
  }, [reloadConfig]);

  const updateConfigValue = React.useCallback(
    (key: string, value: KungfuConfigValue) => {
      try {
        setConfig(setKungfuConfigValue(key, value));
        setConfigError('');
      } catch (e) {
        setConfigError((e as Error).message);
        throw e;
      }
    },
    [],
  );

  const removeConfigValue = React.useCallback((key: string) => {
    try {
      setConfig(unsetKungfuConfigValue(key));
      setConfigError('');
    } catch (e) {
      setConfigError((e as Error).message);
      throw e;
    }
  }, []);

  const setStatusBarItem = React.useCallback((item: StatusBarItem) => {
    if (!item.id) throw new Error('statusBar item id is required');
    if (!item.text) throw new Error('statusBar item text is required');
    setStatusBarItems((current) => ({
      ...current,
      [item.id]: {
        ...item,
        side: item.side ?? 'left',
        priority: item.priority ?? 0,
        severity: item.severity ?? 'info',
      },
    }));
  }, []);

  const clearStatusBarItem = React.useCallback((id: string) => {
    setStatusBarItems((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const dismissNotification = React.useCallback((id: string) => {
    const timer = notificationTimers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      notificationTimers.current.delete(id);
    }
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  const runShellCommand = React.useCallback(
    (command: ShellCommand | undefined) => {
      if (!command) return;
      if (command.kind === 'open-kfx') {
        openKfx(command.kfxId, command.params);
        return;
      }
      if (command.kind === 'open-settings') {
        setSettingsOpen(true);
        return;
      }
      if (command.kind === 'dismiss-notification') {
        dismissNotification(command.notificationId);
      }
    },
    [dismissNotification, openKfx],
  );

  const showNotification = React.useCallback(
    (input: ShellNotificationInput) => {
      const id = notificationId();
      const item: ShellNotification = {
        id,
        level: input.level ?? 'info',
        title: input.title,
        message: input.message,
        timeoutMs: input.timeoutMs ?? 6000,
        actions: input.actions ?? [],
        createdAt: Date.now(),
      };
      setNotifications((current) => [item, ...current].slice(0, 5));
      if (item.timeoutMs !== 0) {
        const timer = window.setTimeout(
          () => dismissNotification(id),
          item.timeoutMs,
        );
        notificationTimers.current.set(id, timer);
      }
      return id;
    },
    [dismissNotification],
  );

  const uiConfig = normalizedUiConfig(config);

  React.useEffect(() => {
    try {
      const electron = window.require('electron') as {
        webFrame?: { setZoomFactor: (factor: number) => void };
      };
      electron.webFrame?.setZoomFactor(uiConfig.scale);
    } catch {
      // non-electron tests or previews keep CSS sizing without webFrame zoom
    }
  }, [uiConfig.scale]);

  const settingFallbacks: Record<string, string> = Object.fromEntries(
    loaded.entries.flatMap((entry) =>
      entry.settings.map((decl) => [decl.key, decl.fallback]),
    ),
  );

  const activeKfx =
    enabled.find((k) => k.id === active) ??
    enabled.find((k) => k.id === profileHomeId(profile, enabled)) ??
    enabled[0] ??
    null;

  const sessionWindowLaunch =
    React.useMemo<SessionWindowLaunchAuthorization | null>(() => {
      const entry = loaded.entries.find(
        (candidate) =>
          candidate.tier === 'node-integrated' &&
          candidate.capabilities.includes('terminal') &&
          candidate.authorizationRoot !== null,
      );
      if (!entry || !entry.authorizationRoot || !kfxDescriptor) return null;
      return {
        descriptor: kfxDescriptor,
        packageKey: entry.id,
        authorizationRoot: entry.authorizationRoot,
      };
    }, [kfxDescriptor, loaded.entries]);

  // KF-ADR-019f86da-4f90-7153-a6c1-ab7a0a3cf481 stage 2/3: expose per-session OS window control to views through the
  // shell so a view stays electron-free. Present only when the flag is on and
  // this (node-integrated) renderer can reach ipc; absent otherwise, so a view
  // feature-detects and hides the affordance. Built once — the ipc handle and
  // flag are stable over the shell's life.
  //
  // Also requires the durable host to run in the main process (stage 3): a
  // popped-out window renders the live terminal by reaching that shared host over
  // the relay, which is impossible when the host lives in this renderer. So
  // pop-out is offered only when both flags are on, never a window that cannot
  // reach its session.
  const sessionWindowShell = React.useMemo<Partial<Shell>>(() => {
    if (
      window.process?.env?.KF_SESSION_WINDOWS !== '1' ||
      window.process?.env?.KF_TERMINAL_HOST !== 'main' ||
      !sessionWindowLaunch
    )
      return {};
    type SessionWindowIpc = {
      invoke: (channel: string, payload: unknown) => Promise<unknown>;
      on: (
        channel: string,
        listener: (event: unknown, payload: unknown) => void,
      ) => void;
      removeListener: (
        channel: string,
        listener: (event: unknown, payload: unknown) => void,
      ) => void;
    };
    let ipc: SessionWindowIpc | null = null;
    try {
      ipc = (window.require('electron') as { ipcRenderer: SessionWindowIpc })
        .ipcRenderer;
    } catch {
      ipc = null;
    }
    if (!ipc) return {};
    const ipcRenderer = ipc;
    return {
      popOutSession: (runId) => {
        const windowId = globalThis.crypto?.randomUUID?.() ?? `w-${runId}`;
        void ipcRenderer.invoke(SESSION_WINDOW_OPEN_CHANNEL, {
          windowId,
          runId,
          launch: sessionWindowLaunch,
        });
      },
      restoreSessionWindows: (windows) => {
        if (windows.length === 0) return;
        void ipcRenderer.invoke(SESSION_WINDOW_RESTORE_CHANNEL, {
          windows: windows.map((w) => ({
            windowId: w.windowId,
            runId: w.runId,
            saved: {
              displayId: w.displayId,
              bounds: { x: w.x, y: w.y, width: w.width, height: w.height },
            },
            launch: sessionWindowLaunch,
          })),
        });
      },
      onSessionWindowsSnapshot: (fn) => {
        const handler = (_event: unknown, payload: unknown) =>
          fn((payload as { snapshot: SessionWindowRecord[] }).snapshot);
        ipcRenderer.on(SESSION_WINDOW_SNAPSHOT_CHANNEL, handler);
        return () =>
          ipcRenderer.removeListener(SESSION_WINDOW_SNAPSHOT_CHANNEL, handler);
      },
    };
  }, [sessionWindowLaunch]);

  const subscribeRefresh = React.useCallback((fn: () => void) => {
    subscribers.current.add(fn);
    return () => subscribers.current.delete(fn);
  }, []);

  const shell: Shell = {
    open: openKfx,
    params,
    onRefresh: subscribeRefresh,
    setting: (key) => state.settings[key] ?? settingFallbacks[key] ?? '',
    updateState,
    state,
    statusBar: {
      set: setStatusBarItem,
      clear: clearStatusBarItem,
    },
    notify: showNotification,
    dismissNotification,
    config,
    configError,
    reloadConfig,
    setConfigValue: updateConfigValue,
    unsetConfigValue: removeConfigValue,
    info: {
      ok: runtime.ok,
      message: runtime.message,
      runtimeDir: runtime.runtimeDir,
      kungfuVersion: runtime.kungfuVersion,
      runtimeStatus,
      buildInfo: runtime.buildInfo,
      skillManager: runtime.skillManager,
      exports: runtime.exports,
      schemaTypes: runtime.schemaTypes,
    },
    registry: loaded.entries,
    suites: loaded.suites,
    profiles,
    ...sessionWindowShell,
  };

  const sidebarCollapsed = state.sidebarCollapsed;
  const primaryNav = primaryNavigation(profile, enabled);
  const toggleSidebar = React.useCallback(() => {
    updateState({ sidebarCollapsed: !sidebarCollapsed });
  }, [sidebarCollapsed, updateState]);
  const navButton = (item: (typeof primaryNav)[number]) => (
    <button
      key={item.id}
      type="button"
      onClick={() => shell.open(item.id)}
      title={item.title}
      aria-label={item.title}
      aria-current={activeKfx?.id === item.id ? 'page' : undefined}
      style={{
        ...mono,
        display: 'flex',
        alignItems: 'center',
        justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
        width: '100%',
        height: sidebarCollapsed ? 32 : undefined,
        minHeight: 32,
        textAlign: sidebarCollapsed ? 'center' : 'left',
        padding: sidebarCollapsed ? 0 : '6px 10px',
        border: 'none',
        borderRadius: 5,
        cursor: 'pointer',
        gap: 8,
        background: activeKfx?.id === item.id ? '#04395e' : 'transparent',
        color: activeKfx?.id === item.id ? '#9cdcfe' : '#cccccc',
        overflow: 'hidden',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 16, flexShrink: 0 }}>
        {item.icon}
      </span>
      {!sidebarCollapsed && (
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.title}
        </span>
      )}
    </button>
  );
  const labButton = (
    <button
      type="button"
      onClick={() => setLabOpen(true)}
      title="Agent Work Lab"
      aria-label="Agent Work Lab"
      aria-current={labOpen ? 'page' : undefined}
      style={{
        ...mono,
        display: 'flex',
        alignItems: 'center',
        justifyContent: sidebarCollapsed ? 'center' : 'flex-start',
        width: '100%',
        minHeight: 32,
        padding: sidebarCollapsed ? 0 : '6px 10px',
        border: 'none',
        borderRadius: 5,
        cursor: 'pointer',
        gap: 8,
        background: labOpen ? '#04395e' : 'transparent',
        color: labOpen ? '#9cdcfe' : '#cccccc',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 16 }}>
        🧪
      </span>
      {!sidebarCollapsed && <span>Agent Work Lab</span>}
    </button>
  );

  const caps = activeKfx ? subsetCaps(runtime, activeKfx) : null;
  const settingsKfx =
    enabled.find((k) => k.id === 'settings') ??
    loaded.entries.find((k) => k.id === 'settings') ??
    null;
  const settingsCaps = settingsKfx ? subsetCaps(runtime, settingsKfx) : null;
  const viewSearchDocuments = React.useMemo<ProductSearchDocument[]>(
    () =>
      enabled.map((entry, index) => ({
        id: `view.${entry.id}`,
        kind: 'view',
        title: entry.title,
        summary: `Open the ${entry.title} product view.`,
        keywords: [entry.id, ...(entry.product.roles ?? [])],
        priority: index,
        action: { kind: 'open-view', viewId: entry.id },
      })),
    [enabled],
  );
  const searchDocuments = React.useMemo(
    () => [
      ...capability.SYSTEM_HELP_DOCUMENTS,
      ...cliSearchDocuments,
      ...globalWorkSearchDocuments,
      ...workSearchDocuments,
      ...viewSearchDocuments,
    ],
    [
      cliSearchDocuments,
      globalWorkSearchDocuments,
      viewSearchDocuments,
      workSearchDocuments,
    ],
  );
  const searchResults = React.useMemo(
    () => capability.searchProductDocuments(searchDocuments, searchText),
    [searchDocuments, searchText],
  );
  const activateSearchResult = React.useCallback(
    (result: ProductSearchResult) => {
      if (result.action.kind === 'open-view') {
        openKfx(result.action.viewId);
      } else if (result.action.kind === 'open-work') {
        const workView = productRoleEntry(enabled, 'profile-view');
        if (workView) {
          openKfx(workView.id, { workId: result.action.workId });
        } else {
          showNotification({
            level: 'warning',
            title: 'Work view unavailable',
            message:
              'The Work result remains read-only, but no enabled Profile view can open its details.',
          });
        }
      } else {
        showNotification({
          level: 'info',
          title: result.title,
          message: result.summary,
        });
      }
      setSearchText('');
    },
    [enabled, openKfx, showNotification],
  );

  const workspaceRuntime = deriveWorkspaceRuntimePresentation(runtimeStatus);
  const trustCounts = runtimeStatus?.payload?.assessments?.counts ?? {};
  const trustBlocked =
    (trustCounts.stale ?? 0) +
    (trustCounts['insufficient-evidence'] ?? 0) +
    (trustCounts.conflicted ?? 0) +
    (trustCounts.unverifiable ?? 0) +
    (trustCounts['failed-retryable'] ?? 0);
  const trustPending = (trustCounts.pending ?? 0) + (trustCounts.running ?? 0);
  const statusEntry = productRoleEntry(enabled, 'devtool');
  const managerEntry = productRoleEntry(enabled, 'system-management');
  const statusCommand = statusEntry
    ? ({ kind: 'open-kfx', kfxId: statusEntry.id } as const)
    : undefined;
  const systemStatusItems: StatusBarItem[] = [
    {
      id: 'system.workspace-runtime',
      text: workspaceRuntime.label,
      icon: workspaceRuntime.icon,
      severity: workspaceRuntime.severity,
      side: 'left',
      priority: -100,
      tooltip: workspaceRuntime.detail,
      command: statusCommand,
    },
    {
      id: 'system.runtime',
      text: runtime.message || (runtime.ok ? 'runtime ready' : 'runtime down'),
      icon: runtime.ok ? '●' : '○',
      severity: runtime.ok ? 'ok' : 'error',
      side: 'left',
      priority: -90,
      tooltip: 'Runtime binding status',
      command: statusCommand,
    },
    {
      id: 'system.trust',
      text: trustStatusText(runtimeStatus),
      icon: trustBlocked > 0 ? '!' : trustPending > 0 ? '◐' : '✓',
      severity:
        trustBlocked > 0 ? 'error' : trustPending > 0 ? 'warning' : 'ok',
      side: 'left',
      priority: -85,
      tooltip: trustTooltip(runtimeStatus),
      command: statusCommand,
    },
    {
      id: 'system.profile',
      text: `profile: ${profile.id}`,
      side: 'right',
      priority: 90,
      tooltip: 'Active profile',
      command: { kind: 'open-settings' },
    },
    {
      id: 'system.kfx-count',
      text: `${enabled.length} kfx`,
      side: 'right',
      priority: 100,
      tooltip: 'Loaded extension views',
      command: managerEntry
        ? { kind: 'open-kfx', kfxId: managerEntry.id }
        : undefined,
    },
  ];

  const allStatusItems = [
    ...systemStatusItems,
    ...Object.values(statusBarItems),
  ].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id),
  );

  const renderStatusItem = (item: StatusBarItem) => {
    const color = statusColor(item.severity);
    const content = (
      <>
        {item.icon ? <span style={{ color }}>{item.icon}</span> : null}
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {item.text}
        </span>
      </>
    );
    const style: React.CSSProperties = {
      ...mono,
      height: 24,
      maxWidth: 260,
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '0 8px',
      boxSizing: 'border-box',
      border: 'none',
      borderRadius: 0,
      background: 'transparent',
      color: '#ffffff',
      cursor: item.command ? 'pointer' : 'default',
      overflow: 'hidden',
      flexShrink: 0,
    };
    if (!item.command) {
      return (
        <span key={item.id} title={item.tooltip} style={style}>
          {content}
        </span>
      );
    }
    return (
      <button
        key={item.id}
        type="button"
        title={item.tooltip}
        onClick={() => runShellCommand(item.command)}
        style={style}
      >
        {content}
      </button>
    );
  };

  const notificationToasts =
    notifications.length > 0 ? (
      <div
        aria-live="polite"
        style={{
          position: 'fixed',
          right: 16,
          bottom: 36,
          zIndex: 900,
          width: 'min(360px, calc(100vw - 32px))',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          pointerEvents: 'none',
        }}
      >
        {notifications.map((item) => (
          <section
            key={item.id}
            style={{
              border: '1px solid #3c3c3c',
              borderLeft: `3px solid ${notificationColor(item.level)}`,
              borderRadius: 6,
              background: '#252526',
              boxShadow: '0 12px 36px rgba(0, 0, 0, 0.36)',
              pointerEvents: 'auto',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '10px 10px 8px 12px',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {item.title}
                </div>
                {item.message ? (
                  <div
                    style={{
                      ...mono,
                      marginTop: 4,
                      color: '#cccccc',
                      whiteSpace: 'pre-wrap',
                    }}
                  >
                    {item.message}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => dismissNotification(item.id)}
                style={{
                  ...mono,
                  width: 22,
                  height: 22,
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  background: 'transparent',
                  color: '#cccccc',
                }}
              >
                ×
              </button>
            </div>
            {item.actions && item.actions.length > 0 ? (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  gap: 8,
                  padding: '0 10px 10px 12px',
                }}
              >
                {item.actions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    onClick={() => runShellCommand(action.command)}
                    style={{
                      ...mono,
                      border: '1px solid #3c3c3c',
                      borderRadius: 4,
                      cursor: 'pointer',
                      background: '#1e1e1e',
                      color: '#cccccc',
                      padding: '4px 8px',
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </section>
        ))}
      </div>
    ) : null;

  const statusBar = (
    <footer
      style={{
        width: '100%',
        height: 24,
        padding: '0 8px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        flexShrink: 0,
        overflow: 'hidden',
        boxSizing: 'border-box',
        borderTop: '1px solid #0e639c',
        background: '#007acc',
        color: '#ffffff',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        {allStatusItems
          .filter((item) => (item.side ?? 'left') === 'left')
          .map(renderStatusItem)}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          overflow: 'hidden',
          minWidth: 0,
        }}
      >
        {allStatusItems
          .filter((item) => item.side === 'right')
          .map(renderStatusItem)}
      </div>
    </footer>
  );

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (settingsOpen || workspaceOpen)) {
        event.preventDefault();
        setSettingsOpen(false);
        setWorkspaceOpen(false);
        return;
      }
      if (event.key === ',' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settingsOpen, workspaceOpen]);

  const workspaceOverlay = workspaceOpen ? (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setWorkspaceOpen(false);
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0, 0, 0, 0.5)',
        boxSizing: 'border-box',
      }}
    >
      <WorkspacePanel />
    </div>
  ) : null;

  const settingsOverlay = settingsOpen ? (
    <div
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setSettingsOpen(false);
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0, 0, 0, 0.42)',
        boxSizing: 'border-box',
      }}
    >
      <dialog
        open
        aria-label="Settings"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: 'min(980px, 100%)',
          maxHeight: 'min(720px, calc(100vh - 48px))',
          minHeight: 420,
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          border: '1px solid #3c3c3c',
          borderRadius: 8,
          background: '#252526',
          boxShadow: '0 20px 80px rgba(0, 0, 0, 0.45)',
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 14px',
            borderBottom: '1px solid #3c3c3c',
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 600 }}>Settings</div>
          <button
            type="button"
            aria-label="Close settings"
            onClick={() => setSettingsOpen(false)}
            style={{
              ...mono,
              width: 28,
              height: 28,
              border: '1px solid #3c3c3c',
              borderRadius: 6,
              cursor: 'pointer',
              background: '#1e1e1e',
              color: '#cccccc',
            }}
          >
            ×
          </button>
        </header>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 14 }}>
          {settingsKfx && settingsCaps ? (
            <KfxErrorBoundary kfxId={settingsKfx.id}>
              <settingsKfx.View caps={settingsCaps} shell={shell} />
            </KfxErrorBoundary>
          ) : (
            <div style={{ ...mono, color: '#f48771' }}>
              settings kfx unavailable
            </div>
          )}
        </div>
      </dialog>
    </div>
  ) : null;

  const appStyle = {
    '--kf-ui-font-family': resolvedUiFontFamily(uiConfig.fontFamily),
    '--kf-mono-font-family': resolvedMonoFontFamily(uiConfig.fontFamily),
    '--kf-font-size': `${uiConfig.fontSize}px`,
    fontFamily: 'var(--kf-ui-font-family)',
    fontSize: 'var(--kf-font-size)',
    color: '#cccccc',
    background: '#1e1e1e',
    width: '100%',
    height: '100%',
    margin: 0,
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  } as React.CSSProperties;

  const chromeBodyStyle = {
    flex: 1,
    minHeight: 0,
    padding: '14px 16px 12px',
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    overflow: 'hidden',
  } as React.CSSProperties;

  return (
    <div style={appStyle}>
      <ShellTitleBar
        chrome={windowChrome}
        activeTitle={
          labOpen ? 'Agent Work Lab' : (activeKfx?.title ?? 'Kungfu Episodes')
        }
        searchText={searchText}
        searchResults={searchResults}
        searchStatus={searchCatalogStatus}
        settingsOpen={settingsOpen}
        workspaceLabel={
          window.process.env.KF_WORKSPACE_DISPLAY_PATH || 'Home Workspace'
        }
        onSearchChange={setSearchText}
        onSearchActivate={activateSearchResult}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenWorkspace={() => setWorkspaceOpen(true)}
        onWindowControl={controlWindow}
      />
      <div style={chromeBodyStyle}>
        <div
          style={{
            display: 'flex',
            gap: 12,
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
          }}
        >
          <nav
            aria-label="Views"
            style={{
              width: sidebarCollapsed ? 44 : 150,
              flexShrink: 0,
              minHeight: 0,
              overflow: 'auto',
              overflowX: 'hidden',
              transition: 'width 120ms ease',
            }}
          >
            <button
              type="button"
              aria-label={
                sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
              }
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onClick={toggleSidebar}
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
              {sidebarCollapsed ? '›' : '‹'}
            </button>
            {labButton}
            {primaryNav.map(navButton)}
            {loaded.failures.length > 0 && (
              <div
                title={`${loaded.failures.length} kfx failed to load`}
                style={{
                  ...mono,
                  color: '#f48771',
                  marginTop: 12,
                  fontSize: 10,
                  textAlign: sidebarCollapsed ? 'center' : 'left',
                }}
              >
                {sidebarCollapsed
                  ? '!'
                  : `${loaded.failures.length} kfx failed to load`}
              </div>
            )}
          </nav>
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
            {labOpen ? (
              <AgentWorkLabPanel
                lab={agentWorkLab}
                startup={startup}
                onOpenWork={() => setLabOpen(false)}
              />
            ) : runtime.ok ? (
              activeKfx && activeKfx.tier === 'sandboxed-ipc' ? (
                // isolated third-party view: embedded, not mounted here
                <KfxErrorBoundary kfxId={activeKfx.id}>
                  <SandboxSlot
                    key={activeKfx.id}
                    entry={activeKfx}
                    caps={sandboxSubset(runtime, activeKfx)}
                  />
                </KfxErrorBoundary>
              ) : activeKfx && caps ? (
                <KfxErrorBoundary kfxId={activeKfx.id}>
                  <activeKfx.View caps={caps} shell={shell} />
                </KfxErrorBoundary>
              ) : (
                <section style={panelStyle}>
                  <div style={{ ...mono, color: '#f48771' }}>
                    no kfx available
                    {loaded.entries.length === 0
                      ? ' — no extensions found on the extension path'
                      : ` for view "${active}"`}
                  </div>
                  {loaded.failures.map((failure) => (
                    <div
                      key={failure.dir}
                      style={{ ...mono, color: '#858585', marginTop: 4 }}
                    >
                      {failure.dir}: {failure.error}
                    </div>
                  ))}
                </section>
              )
            ) : (
              <div
                style={{
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {window.process.env.KF_WORKSPACE_STATE === 'uninitialized' ||
                window.process.env.KF_WORKSPACE_STATE === 'shadow-only' ||
                window.process.env.KF_WORKSPACE_STATE === 'evidence-degraded' ||
                window.process.env.KF_WORKSPACE_STATE === 'unavailable' ? (
                  <WorkspacePanel />
                ) : (
                  <RuntimeFailurePanel message={runtime.message} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {notificationToasts}
      {workspaceOverlay}
      {settingsOverlay}
      {statusBar}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
