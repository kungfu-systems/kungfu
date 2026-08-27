import * as capability from '@kungfu-tech/api/capability';
import type {
  KfxExperienceFlowDescriptor,
  ProductSearchDocument,
  ProductSearchResult,
  ProjectsCatalog,
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
} from '@kungfu-tech/kfx';
import { mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';
import * as ReactDOM from 'react-dom';
import { createRoot } from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import { ProjectWorkControlView } from '../../../../../extensions/work-dashboard/src/view/index';
import {
  actionableKfxFailures,
  shouldOpenAgentWorkLab,
  unavailableKfxMessage,
} from '../../kfx-availability';
import type { SessionWindowLaunchAuthorization } from '../../main/session-windows';
import {
  accessibleEntries,
  availableProfiles,
  createShellNavigationHandler,
  focusedProfile,
  initialShellSurface,
  primaryNavigation,
  productRoleEntry,
  profileHomeId,
  projectSearchSurface,
  shellSurfaceActiveViewId,
  shellSurfaceFlags,
  shellSurfaceTitle,
  visibleCoreSurface,
} from '../../navigation';
import {
  type RuntimeStatusResult,
  deriveWorkspaceRuntimePresentation,
} from '../../runtime-status';
import {
  GLOBAL_WORK_OBSERVER_EVENT_CHANNEL,
  GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL,
  GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL,
  RUNTIME_STATUS_GET_CHANNEL,
  SESSION_WINDOW_OPEN_CHANNEL,
  SESSION_WINDOW_RESTORE_CHANNEL,
  SESSION_WINDOW_SNAPSHOT_CHANNEL,
  SHELL_NAVIGATE_CHANNEL,
  SHELL_REFRESH_CHANNEL,
  type ShellNavigateRequest,
} from '../../sandbox/channels';
import { publishRefresh } from '../../sandbox/refresh';
import { createKfxSharedModules } from '../shared-modules';
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
  AgentFirstOnboardingPanel,
  NotificationToasts,
  ShellOverlays,
  StatusBarView,
  type WindowChromeConfig,
  type WindowChromeControl,
  createLabOnboardingRoutes,
  deferredAgentWorkStartup,
  useAgentFirstEntry,
  useWindowChrome,
} from './product-navigation';
import {
  KfxErrorBoundary,
  ProjectsPanel,
  RetainedCoreSurfaceStack,
  RuntimeFailurePanel,
  WorkspacePanel,
  kfxNativePlanArgs,
  openRendererProjects,
  resolveKfxHostDescriptor,
  useRetainedCoreSurfaces,
  workspaceIpc,
} from './projects-panel';
import {
  type Runtime,
  bootRuntime,
  deferredRuntime,
  guiKungfuCliArgs,
  openRendererAgentWorkLab,
} from './runtime';
import { sandboxClient } from './sandbox-client';
import {
  DEFAULT_STATE,
  exitHistoryStatusItem,
  loadShellState,
  notificationId,
  saveShellState,
  trustStatusText,
  trustTooltip,
  useExitHistoryStatus,
} from './shell-state';

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
    assignmentRuntime: runtime.assignmentRuntime,
    agentRuntime: runtime.agentRuntime,
    agentSession: runtime.agentSession,
    agentWorkLab: runtime.agentWorkLab,
    workspace: runtime.workspace,
    projects: runtime.projects,
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
    assignmentRuntime: runtime.assignmentRuntime,
    agentRuntime: runtime.agentRuntime,
    agentSession: runtime.agentSession,
    agentWorkLab: runtime.agentWorkLab,
    workspace: runtime.workspace,
    projects: runtime.projects,
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

const WORKSPACE_RECOVERY_STATES: ReadonlySet<string | undefined> = new Set([
  'uninitialized',
  'shadow-only',
  'evidence-degraded',
  'unavailable',
]);

function ActiveKfxSurface({
  runtime,
  activeKfx,
  caps,
  shell,
  active,
  entryCount,
  discoveredKfxCount,
  failures,
}: {
  runtime: Runtime;
  activeKfx: KfxEntry | null;
  caps: KfxCapabilities | null;
  shell: Shell;
  active: string;
  entryCount: number;
  discoveredKfxCount: number;
  failures: Array<{ dir: string; error: string }>;
}) {
  if (!runtime.ok) {
    const workspaceNeedsRecovery = WORKSPACE_RECOVERY_STATES.has(
      window.process.env.KF_WORKSPACE_STATE,
    );
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {workspaceNeedsRecovery ? (
          <WorkspacePanel />
        ) : (
          <RuntimeFailurePanel message={runtime.message} />
        )}
      </div>
    );
  }

  if (activeKfx?.tier === 'sandboxed-ipc') {
    return (
      <KfxErrorBoundary kfxId={activeKfx.id}>
        <SandboxSlot
          key={activeKfx.id}
          entry={activeKfx}
          caps={sandboxSubset(runtime, activeKfx)}
        />
      </KfxErrorBoundary>
    );
  }

  if (activeKfx && caps) {
    return (
      <KfxErrorBoundary kfxId={activeKfx.id}>
        <activeKfx.View caps={caps} shell={shell} />
      </KfxErrorBoundary>
    );
  }

  return (
    <section style={panelStyle}>
      <div style={{ ...mono, color: '#f48771' }}>
        no kfx available
        {entryCount === 0
          ? ` — ${unavailableKfxMessage(discoveredKfxCount)}`
          : ` for view "${active}"`}
      </div>
      {failures.map((failure) => (
        <div
          key={failure.dir}
          style={{ ...mono, color: '#858585', marginTop: 4 }}
        >
          {failure.dir}: {failure.error}
        </div>
      ))}
    </section>
  );
}

type ElectronChromeStyle = React.CSSProperties & {
  WebkitAppRegion?: 'drag' | 'no-drag';
};

function ShellTitleBar({
  chrome,
  activeTitle,
  searchText,
  searchResults,
  searchStatus,
  settingsOpen,
  activeViewId,
  advancedItems,
  failures,
  onSearchChange,
  onSearchActivate,
  onOpenSettings,
  onOpenAllWork,
  currentProjectTitle,
  onOpenCurrentProject,
  onOpenProjects,
  onOpenLab,
  onOpenView,
  onWindowControl,
}: {
  chrome: WindowChromeConfig;
  activeTitle: string;
  searchText: string;
  searchResults: ProductSearchResult[];
  searchStatus: string;
  settingsOpen: boolean;
  activeViewId?: string;
  advancedItems: ReturnType<typeof primaryNavigation>;
  failures: Array<{ dir: string; error: string }>;
  onSearchChange: (value: string) => void;
  onSearchActivate: (result: ProductSearchResult) => void;
  onOpenSettings: () => void;
  onOpenAllWork: () => void;
  currentProjectTitle: string;
  onOpenCurrentProject?: () => void;
  onOpenProjects: () => void;
  onOpenLab: () => void;
  onOpenView: (id: string) => void;
  onWindowControl: (control: WindowChromeControl) => void;
}) {
  const searchRoot = React.useRef<HTMLFormElement>(null);
  const menuRoot = React.useRef<HTMLDivElement>(null);
  const searchInput = React.useRef<HTMLInputElement>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [selectedSearchResult, setSelectedSearchResult] = React.useState(0);
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        searchInput.current?.focus();
        searchInput.current?.select();
      } else if (event.key === 'Escape') {
        setSearchOpen(false);
        setMenuOpen(false);
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
      if (
        target instanceof Node &&
        menuRoot.current &&
        !menuRoot.current.contains(target)
      ) {
        setMenuOpen(false);
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
  const activateMenu = (action: () => void) => {
    setMenuOpen(false);
    action();
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
            placeholder="Search Help, Commands, Work, Projects"
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
        <div
          ref={menuRoot}
          style={{ ...interactiveRegion, position: 'relative' }}
        >
          <button
            type="button"
            aria-label="Open product menu"
            aria-expanded={menuOpen}
            title="Navigate Kungfu"
            onClick={() => setMenuOpen((open) => !open)}
            style={{
              ...mono,
              maxWidth: 210,
              height: 28,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              border: '1px solid #3c3c3c',
              borderRadius: 6,
              cursor: 'pointer',
              background: menuOpen ? '#04395e' : '#252526',
              color: '#9cdcfe',
              padding: '0 9px',
            }}
          >
            ☰ {activeTitle}
          </button>
          {menuOpen ? (
            <nav
              aria-label="Kungfu product menu"
              style={{
                position: 'absolute',
                top: 32,
                right: 0,
                width: 250,
                maxHeight: 'min(520px, calc(100vh - 64px))',
                overflow: 'auto',
                padding: 6,
                boxSizing: 'border-box',
                border: '1px solid #454545',
                borderRadius: 8,
                background: '#202124',
                boxShadow: '0 16px 42px rgba(0, 0, 0, 0.58)',
              }}
            >
              {[
                {
                  id: 'all-work',
                  title: 'All Work',
                  icon: '◎',
                  active: activeViewId === 'core-work',
                  action: onOpenAllWork,
                },
                {
                  id: 'projects',
                  title: 'All Projects',
                  icon: '◫',
                  active: activeViewId === 'projects',
                  action: onOpenProjects,
                },
                ...(onOpenCurrentProject
                  ? [
                      {
                        id: 'current-project',
                        title: currentProjectTitle,
                        icon: '▣',
                        active: activeViewId === 'current-project',
                        action: onOpenCurrentProject,
                      },
                    ]
                  : []),
                {
                  id: 'agent-work-lab',
                  title: 'Agent Work Lab',
                  icon: '🧪',
                  active: activeViewId === 'agent-work-lab',
                  action: onOpenLab,
                },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-current={item.active ? 'page' : undefined}
                  onClick={() => activateMenu(item.action)}
                  style={{
                    ...mono,
                    width: '100%',
                    minHeight: 34,
                    display: 'grid',
                    gridTemplateColumns: '22px minmax(0, 1fr)',
                    alignItems: 'center',
                    gap: 8,
                    padding: '7px 10px',
                    border: 'none',
                    borderRadius: 5,
                    cursor: 'pointer',
                    textAlign: 'left',
                    background: item.active ? '#04395e' : 'transparent',
                    color: item.active ? '#9cdcfe' : '#e6edf3',
                  }}
                >
                  <span aria-hidden="true">{item.icon}</span>
                  <span>{item.title}</span>
                </button>
              ))}
              {advancedItems.length > 0 ? (
                <>
                  <div
                    style={{
                      ...mono,
                      margin: '6px 8px 3px',
                      paddingTop: 7,
                      borderTop: '1px solid #3c3c3c',
                      color: '#9aa0a6',
                      fontSize: 11,
                    }}
                  >
                    More
                  </div>
                  {advancedItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={
                        activeViewId === item.id ? 'page' : undefined
                      }
                      onClick={() => activateMenu(() => onOpenView(item.id))}
                      style={{
                        ...mono,
                        width: '100%',
                        minHeight: 32,
                        display: 'grid',
                        gridTemplateColumns: '22px minmax(0, 1fr)',
                        alignItems: 'center',
                        gap: 8,
                        padding: '6px 10px',
                        border: 'none',
                        borderRadius: 5,
                        cursor: 'pointer',
                        textAlign: 'left',
                        background:
                          activeViewId === item.id ? '#04395e' : 'transparent',
                        color: activeViewId === item.id ? '#9cdcfe' : '#d7dde5',
                      }}
                    >
                      <span aria-hidden="true">{item.icon}</span>
                      <span>{item.title}</span>
                    </button>
                  ))}
                </>
              ) : null}
              {failures.length > 0 ? (
                <div
                  title={failures
                    .map((failure) => `${failure.dir}: ${failure.error}`)
                    .join('\n')}
                  style={{
                    ...mono,
                    margin: '8px 8px 4px',
                    color: '#f48771',
                    fontSize: 11,
                  }}
                >
                  {failures.length} kfx failed to load
                </div>
              ) : null}
            </nav>
          ) : null}
        </div>
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

function resolveGuiKfxDescriptor(
  runtime: Runtime,
  skipKfx: boolean,
): KfxExperienceFlowDescriptor | null {
  if (skipKfx) return null;
  const env = window.process.env as Record<string, string | undefined>;
  return resolveKfxHostDescriptor({
    nativePlan: () => runtime.storage?.kfxRegistry('plan', {}),
    cliPlan: () => {
      const childProcess = window.require('node:child_process') as {
        execFileSync: (
          file: string,
          args: string[],
          options: {
            encoding: 'utf8';
            env: Record<string, string | undefined>;
            maxBuffer: number;
          },
        ) => string;
      };
      const path = window.require('node:path') as Pick<
        typeof import('node:path'),
        'delimiter' | 'dirname' | 'resolve'
      >;
      const fs = window.require('node:fs') as {
        existsSync: (value: string) => boolean;
      };
      const bin = env.KUNGFU_CLI_BIN || env.KUNGFU_BIN;
      if (!bin) throw new Error('Kungfu CLI is unavailable');
      const raw = childProcess.execFileSync(
        bin,
        guiKungfuCliArgs(env, kfxNativePlanArgs(env, path, fs.existsSync)),
        { encoding: 'utf8', env, maxBuffer: 4 * 1024 * 1024 },
      );
      return JSON.parse(raw) as unknown;
    },
  });
}

function emptyKfxLoadResult(): KfxLoadResult {
  return {
    discoveredKfxCount: 0,
    entries: [],
    suites: {},
    profiles: [],
    failures: [],
  };
}

function useCliSearchCatalog() {
  const [documents, setDocuments] = React.useState<ProductSearchDocument[]>([]);
  const [status, setStatus] = React.useState(
    'Loading governed command catalog',
  );
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
            execFile(
              file,
              guiKungfuCliArgs(env, args),
              options,
              (error, stdout, stderr) =>
                error
                  ? reject(new Error(stderr.trim() || error.message))
                  : resolve(stdout),
            );
          }),
      })
      .then((next) => {
        if (!active) return;
        setDocuments(next);
        setStatus(`${next.length} governed Help and Command entries`);
      })
      .catch((error) => {
        if (!active) return;
        setStatus(
          `Command catalog unavailable: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    return () => {
      active = false;
    };
  }, []);
  return { documents, status };
}

function useGlobalWorkSearchDocuments(
  initialProjectsOpen: boolean,
  projectId?: string,
  projectPath?: string,
) {
  const [documents, setDocuments] = React.useState<ProductSearchDocument[]>([]);
  React.useEffect(() => {
    if (initialProjectsOpen && (projectId?.trim() || projectPath?.trim()))
      return;
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
      return;
    }
    const receive = (_event: unknown, payload: GlobalWorkObserverEvent) => {
      if (
        payload?.schema !== 'kungfu.gui.global-work-observer-event/v1' ||
        payload.kind !== 'snapshot'
      )
        return;
      try {
        setDocuments(
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
      ipc.removeListener(GLOBAL_WORK_OBSERVER_EVENT_CHANNEL, receive);
      void ipc.invoke(GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL);
    };
  }, [initialProjectsOpen, projectId, projectPath]);
  return documents;
}

function useRefreshBus() {
  const subscribers = React.useRef(new Set<() => void>());
  const refresh = React.useCallback(() => {
    publishRefresh(subscribers.current, (error) => {
      console.error('[shell] product data refresh failed', error);
    });
  }, []);
  React.useEffect(() => {
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);
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
      return;
    }
    ipc.on(SHELL_REFRESH_CHANNEL, refresh);
    return () => ipc.removeListener(SHELL_REFRESH_CHANNEL, refresh);
  }, [refresh]);
  const subscribe = React.useCallback((fn: () => void) => {
    subscribers.current.add(fn);
    return () => subscribers.current.delete(fn);
  }, []);
  return { subscribers, subscribe };
}

function useRuntimeStatus(runtimeOk: boolean) {
  const [status, setStatus] = React.useState<RuntimeStatusResult | null>(null);
  React.useEffect(() => {
    if (!runtimeOk) return;
    type RuntimeStatusIpc = {
      invoke: (channel: string) => Promise<RuntimeStatusResult>;
    };
    let ipc: RuntimeStatusIpc | null = null;
    try {
      ipc = (window.require('electron') as { ipcRenderer: RuntimeStatusIpc })
        .ipcRenderer;
    } catch {
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void ipc
        .invoke(RUNTIME_STATUS_GET_CHANNEL)
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setStatus({
            ok: false,
            payload: null,
            error: error instanceof Error ? error.message : String(error),
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
  }, [runtimeOk]);
  return status;
}

function useWorkSearchDocuments(
  runtime: Runtime,
  subscribers: React.MutableRefObject<Set<() => void>>,
) {
  const [documents, setDocuments] = React.useState<ProductSearchDocument[]>([]);
  React.useEffect(() => {
    if (!runtime.work) {
      setDocuments([]);
      return;
    }
    const refresh = () => {
      try {
        runtime.work?.refresh();
        setDocuments(
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
        setDocuments([]);
      }
    };
    refresh();
    subscribers.current.add(refresh);
    return () => {
      subscribers.current.delete(refresh);
    };
  }, [runtime.work, subscribers]);
  return documents;
}

function useGuiConfig(
  enabled: KfxEntry[],
  setActive: React.Dispatch<React.SetStateAction<string>>,
) {
  const [config, setConfig] = React.useState<KungfuResolvedConfig | null>(null);
  const [error, setError] = React.useState('');
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
    )
      setActive(consoleEntry.id);
  }, [config, enabled, setActive]);
  const reload = React.useCallback(() => {
    try {
      setConfig(loadKungfuConfig());
      setError('');
    } catch (cause) {
      setConfig(null);
      setError((cause as Error).message);
    }
  }, []);
  React.useEffect(reload, []);
  const setValue = React.useCallback(
    (key: string, value: KungfuConfigValue) => {
      try {
        setConfig(setKungfuConfigValue(key, value));
        setError('');
      } catch (cause) {
        setError((cause as Error).message);
        throw cause;
      }
    },
    [],
  );
  const unsetValue = React.useCallback((key: string) => {
    try {
      setConfig(unsetKungfuConfigValue(key));
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
      throw cause;
    }
  }, []);
  const ui = normalizedUiConfig(config);
  React.useEffect(() => {
    try {
      const electron = window.require('electron') as {
        webFrame?: { setZoomFactor: (factor: number) => void };
      };
      electron.webFrame?.setZoomFactor(ui.scale);
    } catch {
      // non-electron tests or previews keep CSS sizing without webFrame zoom
    }
  }, [ui.scale]);
  return { config, error, reload, setValue, unsetValue, ui };
}

function useStatusBarRegistry() {
  const [items, setItems] = React.useState<Record<string, StatusBarItem>>({});
  const set = React.useCallback((item: StatusBarItem) => {
    if (!item.id) throw new Error('statusBar item id is required');
    if (!item.text) throw new Error('statusBar item text is required');
    setItems((current) => ({
      ...current,
      [item.id]: {
        ...item,
        side: item.side ?? 'left',
        priority: item.priority ?? 0,
        severity: item.severity ?? 'info',
      },
    }));
  }, []);
  const clear = React.useCallback((id: string) => {
    setItems((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);
  return { items, set, clear };
}

function useNotificationCenter(
  openKfx: (kfxId: string, params?: Record<string, string>) => void,
  openSettings: () => void,
) {
  const [notifications, setNotifications] = React.useState<ShellNotification[]>(
    [],
  );
  const timers = React.useRef(new Map<string, number>());
  React.useEffect(
    () => () => {
      for (const timer of timers.current.values()) window.clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );
  const dismiss = React.useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);
  const runCommand = React.useCallback(
    (command: ShellCommand | undefined) => {
      if (!command) return;
      if (command.kind === 'open-kfx')
        return openKfx(command.kfxId, command.params);
      if (command.kind === 'open-settings') return openSettings();
      if (command.kind === 'dismiss-notification')
        dismiss(command.notificationId);
    },
    [dismiss, openKfx, openSettings],
  );
  const show = React.useCallback(
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
        const timer = window.setTimeout(() => dismiss(id), item.timeoutMs);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );
  return { notifications, dismiss, runCommand, show };
}

function useSessionWindowShell(
  descriptor: KfxExperienceFlowDescriptor | null,
  entries: KfxEntry[],
): Partial<Shell> {
  const launch = React.useMemo<SessionWindowLaunchAuthorization | null>(() => {
    const entry = entries.find(
      (candidate) =>
        candidate.tier === 'node-integrated' &&
        candidate.capabilities.includes('terminal') &&
        candidate.authorizationRoot !== null,
    );
    if (!entry?.authorizationRoot || !descriptor) return null;
    return {
      descriptor,
      packageKey: entry.id,
      authorizationRoot: entry.authorizationRoot,
    };
  }, [descriptor, entries]);
  return React.useMemo<Partial<Shell>>(() => {
    if (
      window.process?.env?.KF_SESSION_WINDOWS !== '1' ||
      window.process?.env?.KF_TERMINAL_HOST !== 'main' ||
      !launch
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
      return {};
    }
    return {
      popOutSession: (runId) => {
        const windowId = globalThis.crypto?.randomUUID?.() ?? `w-${runId}`;
        void ipc.invoke(SESSION_WINDOW_OPEN_CHANNEL, {
          windowId,
          runId,
          launch,
        });
      },
      restoreSessionWindows: (windows) => {
        if (windows.length === 0) return;
        void ipc.invoke(SESSION_WINDOW_RESTORE_CHANNEL, {
          windows: windows.map((windowRecord) => ({
            windowId: windowRecord.windowId,
            runId: windowRecord.runId,
            saved: {
              displayId: windowRecord.displayId,
              bounds: {
                x: windowRecord.x,
                y: windowRecord.y,
                width: windowRecord.width,
                height: windowRecord.height,
              },
            },
            launch,
          })),
        });
      },
      onSessionWindowsSnapshot: (fn) => {
        const handler = (_event: unknown, payload: unknown) =>
          fn((payload as { snapshot: SessionWindowRecord[] }).snapshot);
        ipc.on(SESSION_WINDOW_SNAPSHOT_CHANNEL, handler);
        return () =>
          ipc.removeListener(SESSION_WINDOW_SNAPSHOT_CHANNEL, handler);
      },
    };
  }, [launch]);
}

function useAppFoundation() {
  const [agentWorkLab] = React.useState(openRendererAgentWorkLab);
  const [projects] = React.useState(openRendererProjects);
  const workspaceBridge = React.useMemo(workspaceIpc, []);
  const agentFirst = useAgentFirstEntry();
  const initialProjectsOpen =
    window.process.env.KFE_INITIAL_SURFACE === 'projects';
  const initialFocusedProjectPath =
    window.process.env.KFE_FOCUSED_PROJECT_PATH || '';
  const initialCoreWorkOpen = !initialProjectsOpen && !agentFirst.initialOpen;
  const [startup] = React.useState(() =>
    deferredAgentWorkStartup(
      agentFirst.initialOpen
        ? 'onboarding'
        : initialProjectsOpen
          ? 'projects'
          : 'work',
      window.process.env.KF_RUNTIME_DIR || '',
    ),
  );
  const startupSurface = capability.agentWorkLabStartupSurface(startup);
  const [runtime] = React.useState(() =>
    !initialProjectsOpen &&
    !agentFirst.initialOpen &&
    !initialCoreWorkOpen &&
    startupSurface === 'work-graph'
      ? bootRuntime()
      : deferredRuntime(
          agentWorkLab,
          `startup routed to ${startup.route}: ${startup.reasonCode}`,
        ),
  );
  runtime.projects = projects;
  const skipKfx =
    initialProjectsOpen || agentFirst.initialOpen || initialCoreWorkOpen;
  const [kfxDescriptor] = React.useState<KfxExperienceFlowDescriptor | null>(
    () => resolveGuiKfxDescriptor(runtime, skipKfx),
  );
  const [loaded] = React.useState<KfxLoadResult>(() =>
    skipKfx
      ? emptyKfxLoadResult()
      : loadKfx(window.process.env, SHARED_MODULES, kfxDescriptor),
  );
  React.useEffect(() => {
    if (
      window.process.env.KUNGFU_GUI_DEV_SUPERVISOR !== '1' ||
      loaded.failures.length === 0
    )
      return;
    console.error(
      `KF_GUI_KFX_FAILURES ${JSON.stringify(
        loaded.failures.map((failure) => ({
          dir: failure.dir,
          error: failure.error,
        })),
      )}`,
    );
  }, [loaded.failures]);
  const visibleKfxFailures = React.useMemo(
    () => actionableKfxFailures(loaded.failures, kfxDescriptor !== null),
    [kfxDescriptor, loaded.failures],
  );
  const initialAgentWorkLabOpen = skipKfx
    ? false
    : shouldOpenAgentWorkLab(startupSurface, loaded.entries.length);
  return {
    agentWorkLab,
    projects,
    workspaceBridge,
    agentFirst,
    initialProjectsOpen,
    initialFocusedProjectPath,
    startup,
    runtime,
    kfxDescriptor,
    loaded,
    visibleKfxFailures,
    initialAgentWorkLabOpen,
  };
}

function useProductSearch({
  enabled,
  cliDocuments,
  globalWorkDocuments,
  workDocuments,
  searchText,
  focusedProjectPath,
  openKfx,
  openWork,
  openProject,
  notify,
  clearSearch,
}: {
  enabled: KfxEntry[];
  cliDocuments: ProductSearchDocument[];
  globalWorkDocuments: ProductSearchDocument[];
  workDocuments: ProductSearchDocument[];
  searchText: string;
  focusedProjectPath: string;
  openKfx: (id: string) => void;
  openWork: (params: Record<string, string>) => void;
  openProject: (path: string) => void;
  notify: (input: ShellNotificationInput) => string;
  clearSearch: () => void;
}) {
  const [projectDocuments, setProjectDocuments] = React.useState<
    ProductSearchDocument[]
  >([]);
  const [currentProjectName, setCurrentProjectName] = React.useState('');
  const viewDocuments = React.useMemo<ProductSearchDocument[]>(
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
  const documents = React.useMemo(
    () => [
      ...capability.SYSTEM_HELP_DOCUMENTS,
      ...cliDocuments,
      ...globalWorkDocuments,
      ...workDocuments,
      ...projectDocuments,
      ...viewDocuments,
    ],
    [
      cliDocuments,
      globalWorkDocuments,
      projectDocuments,
      viewDocuments,
      workDocuments,
    ],
  );
  const results = React.useMemo(
    () => capability.searchProductDocuments(documents, searchText),
    [documents, searchText],
  );
  const handleCatalog = React.useCallback(
    (catalog: ProjectsCatalog) => {
      setProjectDocuments(capability.projectSearchDocuments(catalog));
      setCurrentProjectName(
        catalog.projects.find((project) => project.path === focusedProjectPath)
          ?.name ??
          catalog.projects.find((project) => project.selected)?.name ??
          '',
      );
    },
    [focusedProjectPath],
  );
  const activate = React.useCallback(
    (result: ProductSearchResult) => {
      if (result.action.kind === 'open-view') openKfx(result.action.viewId);
      else if (result.action.kind === 'open-work')
        openWork({ workId: result.action.workId });
      else if (result.action.kind === 'open-project')
        openProject(result.action.projectPath);
      else
        notify({
          level: 'info',
          title: result.title,
          message: result.summary,
        });
      clearSearch();
    },
    [clearSearch, notify, openKfx, openProject, openWork],
  );
  return { currentProjectName, results, handleCatalog, activate };
}

function buildStatusBarItems({
  runtime,
  runtimeStatus,
  profileId,
  enabled,
  historyItem,
  registered,
}: {
  runtime: Runtime;
  runtimeStatus: RuntimeStatusResult | null;
  profileId: string;
  enabled: KfxEntry[];
  historyItem: StatusBarItem;
  registered: Record<string, StatusBarItem>;
}): StatusBarItem[] {
  const workspace = deriveWorkspaceRuntimePresentation(runtimeStatus);
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
  const system: StatusBarItem[] = [
    {
      id: 'system.workspace-runtime',
      text: workspace.label,
      icon: workspace.icon,
      severity: workspace.severity,
      side: 'left',
      priority: -100,
      tooltip: workspace.detail,
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
    historyItem,
    {
      id: 'system.profile',
      text: `profile: ${profileId}`,
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
  return [...system, ...Object.values(registered)].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.id.localeCompare(b.id),
  );
}

function useShellNavigationState(
  foundation: ReturnType<typeof useAppFoundation>,
) {
  const {
    runtime,
    loaded,
    agentFirst,
    initialProjectsOpen,
    initialFocusedProjectPath,
    initialAgentWorkLabOpen,
  } = foundation;
  const [surface, setSurface] = React.useState(() =>
    initialShellSurface({
      onboardingOpen: agentFirst.initialOpen,
      projectsOpen: initialProjectsOpen,
      focusedProjectPath: initialFocusedProjectPath,
      agentWorkLabOpen: initialAgentWorkLabOpen,
    }),
  );
  const { onboardingOpen, coreWorkOpen } = shellSurfaceFlags(surface);
  const visibleRetainedCoreSurface = visibleCoreSurface(surface);
  const retainedCoreSurfaces = useRetainedCoreSurfaces(
    visibleRetainedCoreSurface,
  );
  const [focusedProjectPath, setFocusedProjectPath] = React.useState(
    initialFocusedProjectPath,
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
  const [params, setParams] = React.useState<Record<string, string>>(
    (): Record<string, string> =>
      initialFocusedProjectPath
        ? { projectPath: initialFocusedProjectPath, projectSection: 'files' }
        : {},
  );
  const lastWorkParamsRef = React.useRef<Record<string, string>>(
    initialFocusedProjectPath
      ? { projectPath: initialFocusedProjectPath, projectSection: 'files' }
      : {},
  );
  const lastProjectParamsRef = React.useRef<Record<string, string> | null>(
    initialFocusedProjectPath
      ? { projectPath: initialFocusedProjectPath, projectSection: 'files' }
      : null,
  );
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [workspaceOpen, setWorkspaceOpen] = React.useState(false);
  const [searchText, setSearchText] = React.useState('');
  const openKfx = React.useCallback(
    (kfxId: string, nextParams?: Record<string, string>) => {
      setSurface('kfx');
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
    if (state.profileId === profile.id) return;
    setState((current) => {
      const next = { ...current, profileId: profile.id };
      if (runtime.domain) saveShellState(runtime.domain, next);
      return next;
    });
  }, [profile.id, runtime.domain, state.profileId]);
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
      return;
    }
    const navigate = createShellNavigationHandler({
      settings: () => setSettingsOpen(true),
      onboarding: () => setSurface('onboarding'),
      'profile-home': () => openKfx(profileHomeId(profile, enabled)),
      view: (request) =>
        openKfx(
          (request as Extract<ShellNavigateRequest, { target: 'view' }>).kfxId,
        ),
    });
    ipc.on(SHELL_NAVIGATE_CHANNEL, navigate);
    return () => ipc.removeListener(SHELL_NAVIGATE_CHANNEL, navigate);
  }, [enabled, openKfx, profile]);
  return {
    surface,
    setSurface,
    onboardingOpen,
    coreWorkOpen,
    visibleRetainedCoreSurface,
    retainedCoreSurfaces,
    focusedProjectPath,
    setFocusedProjectPath,
    state,
    profiles,
    profile,
    enabled,
    active,
    setActive,
    params,
    setParams,
    lastWorkParamsRef,
    lastProjectParamsRef,
    settingsOpen,
    setSettingsOpen,
    workspaceOpen,
    setWorkspaceOpen,
    searchText,
    setSearchText,
    openKfx,
    updateState,
  };
}

function useWorkSurfaceNavigation(
  foundation: ReturnType<typeof useAppFoundation>,
  navigation: ReturnType<typeof useShellNavigationState>,
) {
  const { runtime, loaded, workspaceBridge } = foundation;
  const {
    coreWorkOpen,
    focusedProjectPath,
    setFocusedProjectPath,
    profile,
    enabled,
    active,
    params,
    setParams,
    setSurface,
    openKfx,
    lastWorkParamsRef,
    lastProjectParamsRef,
  } = navigation;
  const activeKfx =
    enabled.find((entry) => entry.id === active) ??
    enabled.find((entry) => entry.id === profileHomeId(profile, enabled)) ??
    enabled[0] ??
    null;
  const primaryNav = primaryNavigation(profile, enabled);
  const workEntry =
    productRoleEntry(enabled, 'profile-view') ??
    enabled.find((entry) => entry.id === profileHomeId(profile, enabled));
  const openCoreWork = React.useCallback(
    (nextParams: Record<string, string>) => {
      setParams(nextParams);
      setSurface('core-work');
    },
    [setParams, setSurface],
  );
  const openWork = React.useCallback(
    (nextParams?: Record<string, string>) => {
      const restoredParams = nextParams ?? lastWorkParamsRef.current;
      if (nextParams && Object.keys(nextParams).length > 0)
        lastWorkParamsRef.current = nextParams;
      const projectPath = restoredParams.projectPath?.trim();
      if (projectPath) {
        lastProjectParamsRef.current = restoredParams;
        setFocusedProjectPath(projectPath);
      }
      if (workEntry) openKfx(workEntry.id, restoredParams);
      else openCoreWork(restoredParams);
    },
    [
      lastProjectParamsRef,
      lastWorkParamsRef,
      openCoreWork,
      openKfx,
      setFocusedProjectPath,
      workEntry,
    ],
  );
  const restoreProject = React.useCallback(
    (projectPath: string, section: 'files' | 'work'): boolean => {
      openWork({ projectPath, projectSection: section });
      return true;
    },
    [openWork],
  );
  const projectWorkOpen =
    (coreWorkOpen || activeKfx?.id === workEntry?.id) &&
    Boolean(params.projectPath?.trim());
  const settingsKfx =
    enabled.find((entry) => entry.id === 'settings') ??
    loaded.entries.find((entry) => entry.id === 'settings') ??
    null;
  return {
    activeKfx,
    workEntry,
    openWork,
    restoreProject,
    advancedNav: primaryNav.filter((item) => item.id !== workEntry?.id),
    projectWorkOpen,
    caps: activeKfx ? subsetCaps(runtime, activeKfx) : null,
    settingsKfx,
    settingsCaps: settingsKfx ? subsetCaps(runtime, settingsKfx) : null,
    handleOpenProject: (workspace: { workspace_root: string }) =>
      workspaceBridge.path(workspace.workspace_root),
    focusedProjectPath,
  };
}

function useShellOverlayShortcuts({
  settingsOpen,
  workspaceOpen,
  setSettingsOpen,
  setWorkspaceOpen,
}: {
  settingsOpen: boolean;
  workspaceOpen: boolean;
  setSettingsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkspaceOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  React.useEffect(() => {
    const onShellKeyDown = (event: KeyboardEvent) => {
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
    window.addEventListener('keydown', onShellKeyDown);
    return () => window.removeEventListener('keydown', onShellKeyDown);
  }, [setSettingsOpen, setWorkspaceOpen, settingsOpen, workspaceOpen]);
}

function ShellWorkspaceContent({
  onboarding,
  retained,
  activeKfx,
}: {
  onboarding: React.ComponentProps<typeof AgentFirstOnboardingPanel> | null;
  retained: React.ComponentProps<typeof RetainedCoreSurfaceStack>;
  activeKfx: React.ComponentProps<typeof ActiveKfxSurface> | null;
}) {
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        padding: '14px 16px 12px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 12,
          flex: 1,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {onboarding ? (
            <AgentFirstOnboardingPanel {...onboarding} />
          ) : (
            <>
              <RetainedCoreSurfaceStack {...retained} />
              {activeKfx ? <ActiveKfxSurface {...activeKfx} /> : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function App() {
  const foundation = useAppFoundation();
  const {
    agentWorkLab,
    projects,
    workspaceBridge,
    agentFirst,
    initialProjectsOpen,
    initialFocusedProjectPath,
    startup,
    runtime,
    kfxDescriptor,
    loaded,
    visibleKfxFailures,
    initialAgentWorkLabOpen,
  } = foundation;
  const {
    entry: agentFirstEntry,
    initialOpen: initialOnboardingOpen,
    persist: persistOnboarding,
    installCli: installOnboardingCli,
  } = agentFirst;
  const navigation = useShellNavigationState(foundation);
  const {
    surface: shellSurface,
    setSurface: setShellSurface,
    onboardingOpen,
    coreWorkOpen,
    visibleRetainedCoreSurface,
    retainedCoreSurfaces,
    focusedProjectPath,
    setFocusedProjectPath,
    state,
    profiles,
    profile,
    enabled,
    active,
    setActive,
    params,
    setParams,
    lastWorkParamsRef,
    lastProjectParamsRef,
    settingsOpen,
    setSettingsOpen,
    workspaceOpen,
    setWorkspaceOpen,
    searchText,
    setSearchText,
    openKfx,
    updateState,
  } = navigation;
  const cliSearchCatalog = useCliSearchCatalog();
  const globalWorkSearchDocuments = useGlobalWorkSearchDocuments(
    initialProjectsOpen,
    params.projectId,
    params.projectPath,
  );
  const refreshBus = useRefreshBus();
  const workSearchDocuments = useWorkSearchDocuments(
    runtime,
    refreshBus.subscribers,
  );
  const [windowChrome, controlWindow] = useWindowChrome();
  const guiConfig = useGuiConfig(enabled, setActive);
  const runtimeStatus = useRuntimeStatus(runtime.ok);
  const historyStatus = useExitHistoryStatus(runtime.ok);
  const statusBarRegistry = useStatusBarRegistry();

  const notificationCenter = useNotificationCenter(openKfx, () =>
    setSettingsOpen(true),
  );
  const labOnboarding = createLabOnboardingRoutes({
    state: agentFirstEntry.state,
    persist: persistOnboarding,
    notify: notificationCenter.show,
    openPath: workspaceBridge.path,
  });

  const settingFallbacks: Record<string, string> = Object.fromEntries(
    loaded.entries.flatMap((entry) =>
      entry.settings.map((decl) => [decl.key, decl.fallback]),
    ),
  );

  const workSurface = useWorkSurfaceNavigation(foundation, navigation);
  const {
    activeKfx,
    workEntry,
    openWork: openWorkSurface,
    restoreProject: restoreProjectWork,
    advancedNav,
    projectWorkOpen,
    caps,
    settingsKfx,
    settingsCaps,
    handleOpenProject,
  } = workSurface;

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
  const sessionWindowShell = useSessionWindowShell(
    kfxDescriptor,
    loaded.entries,
  );

  const shell: Shell = {
    open: openKfx,
    params,
    onRefresh: refreshBus.subscribe,
    setting: (key) => state.settings[key] ?? settingFallbacks[key] ?? '',
    updateState,
    state,
    statusBar: {
      set: statusBarRegistry.set,
      clear: statusBarRegistry.clear,
    },
    notify: notificationCenter.show,
    dismissNotification: notificationCenter.dismiss,
    config: guiConfig.config,
    configError: guiConfig.error,
    reloadConfig: guiConfig.reload,
    setConfigValue: guiConfig.setValue,
    unsetConfigValue: guiConfig.unsetValue,
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

  const openProjectSearch = React.useCallback(
    (projectPath: string) => {
      setFocusedProjectPath(projectPath);
      setShellSurface(projectSearchSurface);
    },
    [setFocusedProjectPath, setShellSurface],
  );
  const productSearch = useProductSearch({
    enabled,
    cliDocuments: cliSearchCatalog.documents,
    globalWorkDocuments: globalWorkSearchDocuments,
    workDocuments: workSearchDocuments,
    searchText,
    focusedProjectPath,
    openKfx,
    openWork: openWorkSurface,
    openProject: openProjectSearch,
    notify: notificationCenter.show,
    clearSearch: () => setSearchText(''),
  });
  const currentProjectDisplayName =
    productSearch.currentProjectName ||
    lastProjectParamsRef.current?.projectPath
      ?.split(/[\\/]/u)
      .filter(Boolean)
      .at(-1) ||
    '';
  const allStatusItems = buildStatusBarItems({
    runtime,
    runtimeStatus,
    profileId: profile.id,
    enabled,
    historyItem: exitHistoryStatusItem(
      historyStatus,
      productRoleEntry(enabled, 'devtool')
        ? {
            kind: 'open-kfx',
            kfxId: productRoleEntry(enabled, 'devtool')?.id ?? '',
          }
        : undefined,
    ),
    registered: statusBarRegistry.items,
  });
  useShellOverlayShortcuts({
    settingsOpen,
    workspaceOpen,
    setSettingsOpen,
    setWorkspaceOpen,
  });

  const onboardingProps: React.ComponentProps<
    typeof AgentFirstOnboardingPanel
  > | null = onboardingOpen
    ? {
        entry: agentFirstEntry,
        onPersist: persistOnboarding,
        onInstallCli: installOnboardingCli,
        onOpenLab: () => setShellSurface('agent-work-lab'),
        onOpenTour: () => {
          setShellSurface('agent-work-lab');
          notificationCenter.show({
            level: 'info',
            title: 'Guided Project Tour',
            message:
              'Create the Starter Project in Agent Work Lab, then follow its Work actions. Kungfu will leave the Project available for continued work.',
          });
        },
        onContinue: () =>
          initialFocusedProjectPath
            ? openWorkSurface({
                projectPath: initialFocusedProjectPath,
                projectSection: 'files',
              })
            : setShellSurface('projects'),
      }
    : null;
  const retainedSurfaceProps: React.ComponentProps<
    typeof RetainedCoreSurfaceStack
  > = {
    visible: visibleRetainedCoreSurface,
    retained: retainedCoreSurfaces,
    projects,
    focusedPath: focusedProjectPath,
    onCatalog: productSearch.handleCatalog,
    onOpenProject: handleOpenProject,
    onOpenExistingProject: () => void workspaceBridge.open(),
    onRestoreProject: restoreProjectWork,
    lab: agentWorkLab,
    startup,
    onOpenWork: () => openWorkSurface(),
    onOpenLabExistingProject: () => setShellSurface('projects'),
    onLabComplete: labOnboarding.completeLab,
    onOpenStarterProject: labOnboarding.openStarterProject,
    work: runtime.assignmentRuntime ? (
      <ProjectWorkControlView
        projects={projects}
        shell={shell}
        assignmentRuntime={runtime.assignmentRuntime}
      />
    ) : null,
  };
  const activeKfxProps: React.ComponentProps<typeof ActiveKfxSurface> | null =
    shellSurface === 'kfx'
      ? {
          runtime,
          activeKfx,
          caps,
          shell,
          active,
          entryCount: loaded.entries.length,
          discoveredKfxCount: loaded.discoveredKfxCount,
          failures: visibleKfxFailures,
        }
      : null;

  const appStyle = {
    '--kf-ui-font-family': resolvedUiFontFamily(guiConfig.ui.fontFamily),
    '--kf-mono-font-family': resolvedMonoFontFamily(guiConfig.ui.fontFamily),
    '--kf-font-size': `${guiConfig.ui.fontSize}px`,
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

  return (
    <div style={appStyle}>
      <ShellTitleBar
        chrome={windowChrome}
        activeTitle={shellSurfaceTitle({
          surface: shellSurface,
          projectWorkOpen,
          currentProjectDisplayName,
          activeKfxTitle: activeKfx?.title,
        })}
        searchText={searchText}
        searchResults={productSearch.results}
        searchStatus={cliSearchCatalog.status}
        settingsOpen={settingsOpen}
        activeViewId={shellSurfaceActiveViewId({
          surface: shellSurface,
          projectWorkOpen,
          activeKfxId: activeKfx?.id,
          workEntryId: workEntry?.id,
        })}
        advancedItems={advancedNav}
        failures={visibleKfxFailures}
        onSearchChange={setSearchText}
        onSearchActivate={productSearch.activate}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAllWork={() => openWorkSurface()}
        currentProjectTitle={
          currentProjectDisplayName
            ? `Project · ${currentProjectDisplayName}`
            : 'Current Project'
        }
        onOpenCurrentProject={
          lastProjectParamsRef.current
            ? () => openWorkSurface(lastProjectParamsRef.current ?? undefined)
            : undefined
        }
        onOpenProjects={() => {
          setFocusedProjectPath('');
          setShellSurface('projects');
        }}
        onOpenLab={() => setShellSurface('agent-work-lab')}
        onOpenView={(id) => shell.open(id)}
        onWindowControl={controlWindow}
      />
      <ShellWorkspaceContent
        onboarding={onboardingProps}
        retained={retainedSurfaceProps}
        activeKfx={activeKfxProps}
      />
      <NotificationToasts
        notifications={notificationCenter.notifications}
        dismiss={notificationCenter.dismiss}
        runCommand={notificationCenter.runCommand}
      />
      <ShellOverlays
        workspaceOpen={workspaceOpen}
        settingsOpen={settingsOpen}
        closeWorkspace={() => setWorkspaceOpen(false)}
        closeSettings={() => setSettingsOpen(false)}
        settingsKfx={settingsKfx}
        settingsCaps={settingsCaps}
        shell={shell}
      />
      <StatusBarView
        items={allStatusItems}
        runCommand={notificationCenter.runCommand}
      />
    </div>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />);
