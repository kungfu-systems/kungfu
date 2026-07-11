import * as capability from '@kungfu-tech/api/capability';
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
import {
  MASTER_STATUS_GET_CHANNEL,
  SESSION_WINDOW_OPEN_CHANNEL,
  SESSION_WINDOW_RESTORE_CHANNEL,
  SESSION_WINDOW_SNAPSHOT_CHANNEL,
  WINDOW_CHROME_CONTROL_CHANNEL,
  WINDOW_CHROME_GET_CHANNEL,
  WINDOW_CHROME_STATE_CHANNEL,
} from '../../sandbox/channels';
import {
  loadKungfuConfig,
  normalizedUiConfig,
  resolvedMonoFontFamily,
  resolvedUiFontFamily,
  setKungfuConfigValue,
  unsetKungfuConfigValue,
} from './gui-config';
import { type KfxLoadResult, loadKfx } from './kfx-loader';
import { type Runtime, bootRuntime } from './runtime';
import { sandboxClient } from './sandbox-client';
import {
  DEFAULT_STATE,
  PROFILES,
  loadShellState,
  profileById,
  saveShellState,
} from './shell-state';

// Modules injected into every kfx bundle (the externals contract of
// `kungfu sdk kfx build`): one React instance, one capability surface.
const SHARED_MODULES = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  'react-dom': ReactDOM,
  '@kungfu-tech/api': capability,
  '@kungfu-tech/api/capability': capability,
};

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
    atlas: runtime.atlas,
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
    atlas: runtime.atlas,
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

type MasterStatusPayload = {
  status?: string;
  configHome?: string;
  dataRoot?: string;
  runtimeDir?: string;
  lifecycle?: {
    state?: string;
    healthy?: boolean;
    warnings?: string[];
  };
  supervisor?: { pid?: number | null; running?: boolean };
  master?: { pid?: number | null; running?: boolean };
  route?: { routeId?: string; registered?: boolean; stale?: boolean };
  routes?: { count?: number; staleCount?: number };
};

type MasterStatusResult = {
  ok: boolean;
  payload: MasterStatusPayload | null;
  error: string;
  updatedAt: number;
};

function masterStatusText(status: MasterStatusResult | null): string {
  if (!status) return 'master checking';
  if (!status.ok || !status.payload) return 'master unavailable';
  const lifecycle = status.payload.lifecycle?.state || status.payload.status;
  if (lifecycle === 'stale-route') return 'master stale route';
  if (lifecycle === 'degraded') return 'master degraded';
  if (lifecycle === 'dead') return 'master dead pid';
  if (lifecycle === 'orphan-master') return 'master orphan';
  const supervisor = status.payload.supervisor?.running;
  const master = status.payload.master?.running;
  if (supervisor && master) return 'master live';
  if (supervisor) return 'master starting';
  if (master) return 'master orphan';
  return 'master offline';
}

function supervisorStatusText(status: MasterStatusResult | null): string {
  if (!status) return 'supervisor checking';
  if (!status.ok || !status.payload) return 'supervisor unavailable';
  const lifecycle = status.payload.lifecycle?.state || status.payload.status;
  if (lifecycle === 'dead') return 'supervisor dead pid';
  if (lifecycle === 'stale-route') return 'supervisor stale route';
  return status.payload.supervisor?.running
    ? 'supervisor live'
    : 'supervisor stopped';
}

function statusTooltip(status: MasterStatusResult | null): string {
  if (!status) return 'Supervisor/master status is being checked';
  if (!status.ok || !status.payload)
    return status.error || 'Status unavailable';
  const payload = status.payload;
  return [
    `Status: ${payload.status || '-'}`,
    `Lifecycle: ${payload.lifecycle?.state || '-'}`,
    `Warnings: ${payload.lifecycle?.warnings?.join(', ') || '-'}`,
    `Config: ${payload.configHome || '-'}`,
    `Data root: ${payload.dataRoot || '-'}`,
    `Runtime: ${payload.runtimeDir || '-'}`,
    `Route: ${payload.route?.routeId || '-'}${
      payload.route?.registered ? ' registered' : ' not registered'
    }${payload.route?.stale ? ' stale' : ''}`,
    `Stale routes: ${String(payload.routes?.staleCount ?? 0)}`,
  ].join('\n');
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
  commandText,
  commandOptions,
  settingsOpen,
  onCommandChange,
  onCommandSubmit,
  onOpenSettings,
  onWindowControl,
}: {
  chrome: WindowChromeConfig;
  activeTitle: string;
  commandText: string;
  commandOptions: { id: string; title: string }[];
  settingsOpen: boolean;
  onCommandChange: (value: string) => void;
  onCommandSubmit: () => void;
  onOpenSettings: () => void;
  onWindowControl: (control: WindowChromeControl) => void;
}) {
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
          onSubmit={(event) => {
            event.preventDefault();
            onCommandSubmit();
          }}
          style={{
            ...interactiveRegion,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <input
            aria-label="Search views"
            list="kf-shell-command-options"
            value={commandText}
            onChange={(event) => onCommandChange(event.target.value)}
            placeholder="Search"
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
          <datalist id="kf-shell-command-options">
            {commandOptions.map((option) => (
              <option key={option.id} value={option.title} />
            ))}
          </datalist>
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

function App() {
  const [runtime] = React.useState(bootRuntime);
  const [loaded] = React.useState<KfxLoadResult>(() =>
    loadKfx(window.process.env, SHARED_MODULES),
  );
  const [state, setState] = React.useState<ShellState>(() =>
    runtime.domain ? loadShellState(runtime.domain) : DEFAULT_STATE,
  );
  const profile = profileById(state.profileId);
  const [active, setActive] = React.useState(
    () => window.process.env.KFE_INITIAL_VIEW || profile.defaultView,
  );
  const [params, setParams] = React.useState<Record<string, string>>({});
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [commandText, setCommandText] = React.useState('');
  const [windowChrome, controlWindow] = useWindowChrome();
  const [config, setConfig] = React.useState<KungfuResolvedConfig | null>(null);
  const [configError, setConfigError] = React.useState('');
  const [masterLive, setMasterLive] = React.useState(
    () => runtime.ledger?.health().live ?? false,
  );
  const [masterStatus, setMasterStatus] =
    React.useState<MasterStatusResult | null>(null);
  const [statusBarItems, setStatusBarItems] = React.useState<
    Record<string, StatusBarItem>
  >({});
  const [notifications, setNotifications] = React.useState<ShellNotification[]>(
    [],
  );
  const notificationTimers = React.useRef(new Map<string, number>());

  // shared refresh bus: one shell-owned timer, kfx subscribe
  const subscribers = React.useRef(new Set<() => void>());
  React.useEffect(() => {
    const timer = setInterval(() => {
      for (const fn of subscribers.current) fn();
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  React.useEffect(() => {
    const refresh = () => setMasterLive(runtime.ledger?.health().live ?? false);
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [runtime.ledger]);

  React.useEffect(() => {
    type MasterStatusIpc = {
      invoke: (channel: string) => Promise<MasterStatusResult>;
    };
    let ipc: MasterStatusIpc | null = null;
    try {
      ipc = (window.require('electron') as { ipcRenderer: MasterStatusIpc })
        .ipcRenderer;
    } catch {
      ipc = null;
    }
    if (!ipc) return;
    let cancelled = false;
    const refresh = () => {
      void ipc
        .invoke(MASTER_STATUS_GET_CHANNEL)
        .then((next) => {
          if (!cancelled) setMasterStatus(next);
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setMasterStatus({
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
  }, []);

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
      setParams(nextParams ?? {});
      setActive(kfxId);
    },
    [],
  );

  const updateState = React.useCallback(
    (patch: Partial<ShellState>) => {
      setState((current) => {
        const next = { ...current, ...patch };
        if (runtime.domain) saveShellState(runtime.domain, next);
        return next;
      });
    },
    [runtime.domain],
  );

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

  const enabled = loaded.entries.filter(
    (entry) =>
      entry.system ||
      // installed third-party views (sandboxed-ipc) are visible once installed,
      // independent of the profile's built-in kfx list
      entry.tier === 'sandboxed-ipc' ||
      (profile.kfx.includes(entry.id) &&
        !state.disabledKfx.includes(entry.id) &&
        !(entry.suite && state.disabledSuites.includes(entry.suite))),
  );
  const activeKfx = enabled.find((k) => k.id === active) ?? enabled[0] ?? null;

  // ADR-0016 stage 2/3: expose per-session OS window control to views through the
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
      window.process?.env?.KF_TERMINAL_HOST !== 'main'
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
  }, []);

  const shell: Shell = {
    open: openKfx,
    params,
    onRefresh: (fn) => {
      subscribers.current.add(fn);
      return () => subscribers.current.delete(fn);
    },
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
      masterStatus,
      buildInfo: runtime.buildInfo,
      skillManager: runtime.skillManager,
      exports: runtime.exports,
      schemaTypes: runtime.schemaTypes,
    },
    registry: loaded.entries,
    suites: loaded.suites,
    profiles: PROFILES,
    ...sessionWindowShell,
  };

  const sidebarCollapsed = state.sidebarCollapsed;
  const toggleSidebar = React.useCallback(() => {
    updateState({ sidebarCollapsed: !sidebarCollapsed });
  }, [sidebarCollapsed, updateState]);
  const navButton = (id: string, title: string) => (
    <button
      key={id}
      type="button"
      onClick={() => shell.open(id)}
      title={sidebarCollapsed ? title : undefined}
      aria-label={title}
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
        background: activeKfx?.id === id ? '#04395e' : 'transparent',
        color: activeKfx?.id === id ? '#9cdcfe' : '#cccccc',
        overflow: 'hidden',
      }}
    >
      {sidebarCollapsed ? title.trim().slice(0, 1).toUpperCase() : title}
    </button>
  );

  const caps = activeKfx ? subsetCaps(runtime, activeKfx) : null;
  const settingsKfx =
    enabled.find((k) => k.id === 'settings') ??
    loaded.entries.find((k) => k.id === 'settings') ??
    null;
  const settingsCaps = settingsKfx ? subsetCaps(runtime, settingsKfx) : null;
  const suiteTitle = (entry: KfxEntry) =>
    entry.suite ? (loaded.suites[entry.suite]?.title ?? entry.suite) : null;
  const plain = enabled.filter((k) => !k.suite);
  const suiteGroups = new Map<string, KfxEntry[]>();
  for (const entry of enabled) {
    if (!entry.suite) continue;
    const group = suiteGroups.get(entry.suite) ?? [];
    group.push(entry);
    suiteGroups.set(entry.suite, group);
  }
  const commandOptions = enabled.map((entry) => ({
    id: entry.id,
    title: entry.title,
  }));
  const submitCommand = React.useCallback(() => {
    const query = commandText.trim().toLowerCase();
    if (!query) return;
    const match =
      enabled.find((entry) => entry.title.toLowerCase() === query) ??
      enabled.find((entry) => entry.id.toLowerCase() === query) ??
      enabled.find((entry) => entry.title.toLowerCase().includes(query)) ??
      enabled.find((entry) => entry.id.toLowerCase().includes(query));
    if (!match) {
      showNotification({
        level: 'info',
        title: 'No matching view',
        message: commandText,
      });
      return;
    }
    openKfx(match.id);
    setCommandText('');
  }, [commandText, enabled, openKfx, showNotification]);

  const supervisorRunning = masterStatus?.payload?.supervisor?.running === true;
  const masterRunning =
    masterStatus?.payload?.master?.running === true ||
    (!masterStatus?.ok && masterLive);
  const lifecycleState =
    masterStatus?.payload?.lifecycle?.state || masterStatus?.payload?.status;
  const lifecycleHealthy = masterStatus?.payload?.lifecycle?.healthy === true;
  const lifecycleDegraded =
    lifecycleState === 'stale-route' ||
    lifecycleState === 'degraded' ||
    lifecycleState === 'dead' ||
    lifecycleState === 'orphan-master';
  const masterSeverity: StatusBarSeverity = lifecycleHealthy
    ? 'ok'
    : lifecycleDegraded || supervisorRunning
      ? 'warning'
      : 'error';
  const systemStatusItems: StatusBarItem[] = [
    {
      id: 'system.supervisor',
      text: supervisorStatusText(masterStatus),
      icon: supervisorRunning ? '●' : '○',
      severity:
        lifecycleState === 'dead'
          ? 'error'
          : supervisorRunning
            ? 'ok'
            : 'warning',
      side: 'left',
      priority: -110,
      tooltip: statusTooltip(masterStatus),
      command: { kind: 'open-kfx', kfxId: 'status' },
    },
    {
      id: 'system.master',
      text: masterStatusText(masterStatus),
      icon: masterRunning ? '●' : '○',
      severity: masterSeverity,
      side: 'left',
      priority: -100,
      tooltip: statusTooltip(masterStatus),
      command: { kind: 'open-kfx', kfxId: 'status' },
    },
    {
      id: 'system.runtime',
      text: runtime.message || (runtime.ok ? 'runtime ready' : 'runtime down'),
      icon: runtime.ok ? '●' : '○',
      severity: runtime.ok ? 'ok' : 'error',
      side: 'left',
      priority: -90,
      tooltip: 'Runtime binding status',
      command: { kind: 'open-kfx', kfxId: 'status' },
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
      command: { kind: 'open-kfx', kfxId: 'kfx-manager' },
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
      if (event.key === 'Escape' && settingsOpen) {
        event.preventDefault();
        setSettingsOpen(false);
        return;
      }
      if (event.key === ',' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSettingsOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [settingsOpen]);

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
        activeTitle={activeKfx?.title ?? 'Kungfu Episodes'}
        commandText={commandText}
        commandOptions={commandOptions}
        settingsOpen={settingsOpen}
        onCommandChange={setCommandText}
        onCommandSubmit={submitCommand}
        onOpenSettings={() => setSettingsOpen(true)}
        onWindowControl={controlWindow}
      />
      <div style={chromeBodyStyle}>
        {runtime.ok ? (
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
              {plain.map((k) => navButton(k.id, k.title))}
              {[...suiteGroups.entries()].map(([key, group]) => (
                <React.Fragment key={key}>
                  {sidebarCollapsed ? (
                    <div
                      aria-hidden="true"
                      style={{
                        height: 1,
                        margin: '10px 6px 6px',
                        background: '#3c3c3c',
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        ...mono,
                        color: '#6a6a6a',
                        margin: '12px 0 4px',
                        fontSize: 10,
                      }}
                    >
                      {suiteTitle(group[0]) ?? key}
                    </div>
                  )}
                  {group.map((k) => navButton(k.id, k.title))}
                </React.Fragment>
              ))}
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
              {activeKfx && activeKfx.tier === 'sandboxed-ipc' ? (
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
              )}
            </div>
          </div>
        ) : (
          <p style={{ ...mono, color: '#f48771' }}>
            binding unavailable — set KFE_PATH to a built kungfu_electron.node
          </p>
        )}
      </div>
      {notificationToasts}
      {settingsOverlay}
      {statusBar}
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
