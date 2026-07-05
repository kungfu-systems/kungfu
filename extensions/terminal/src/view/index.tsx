// Managed session workspace — a canvas of PTY-backed terminals hosted inside
// the Kungfu GUI, so a user runs and watches several managed agent sessions at
// once without leaving Kungfu. This is the visual-concurrency wedge: many
// sessions visible on one screen (a grid that wraps), not a list you page
// through one detail at a time.
//
// The view is pure interaction UI: xterm.js for rendering and keyboard, and the
// declared `terminal` capability for the process. It never touches node-pty
// directly — the PTY host lives in the trusted renderer behind the capability
// boundary, so this view runs identically whether it is loaded node-integrated
// or in a locked sandbox reaching the capability over IPC.
//
// Durability: sessions start on the tmux backend (`backend: 'tmux'`) when the
// host has one, so closing a pane detaches (the agent keeps running) rather than
// killing it, and a detached session can be reattached from the recoverable
// tray. When no tmux backend is present the workspace degrades to direct
// sessions (no durability) and says so per pane. tmux is only a backend — this
// view speaks "session", never "tmux".
//
// Popping a session into its own OS window (ADR-0016 stage 2) is offered through
// the shell: the view stays electron-free and simply asks `shell.popOutSession`,
// which the node-integrated shell owns; the main process places and persists the
// window (F7 clamp on restore). Rendering the live terminal *inside* that OS
// window, rather than the stage-2 placeholder, is the next slice; cost/proof
// badges are later still.
//
// The capability is async at the sandbox boundary (an IPC hop cannot be
// synchronous); `resolve` awaits both the sync (node-integrated) and Promise
// (sandboxed-ipc) shapes so one code path serves both tiers.
import '@xterm/xterm/css/xterm.css';
import type { KfxCapabilities, Shell, TerminalSession } from '@kungfu-tech/kfx';
import { headingStyle, mono, panelStyle } from '@kungfu-tech/kfx';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import React from 'react';
import {
  type PersistedWindow,
  type WorkspaceLayout,
  loadWorkspaceLayout,
  saveWorkspaceLayout,
} from './persistence';

async function resolve<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

type Provider = 'claude' | 'codex';

interface RunProfile {
  id: string;
  label: string;
  provider: Provider;
  prompt: string;
}

// MVP inbox: a few runnable managed-run profiles. A later slice imports real
// work/go cards from the runtime instead of seeding them here.
const INBOX: RunProfile[] = [
  {
    id: 'claude-hello',
    label: 'Claude · greet from a managed run',
    provider: 'claude',
    prompt: 'In one short sentence, say hello from a Kungfu managed run.',
  },
  {
    id: 'claude-summary',
    label: 'Claude · one-line status',
    provider: 'claude',
    prompt: 'Reply with exactly one line: managed run OK.',
  },
  {
    id: 'codex-check',
    label: 'Codex · quick check',
    provider: 'codex',
    prompt: 'Reply with exactly: OK',
  },
];

// How to launch a managed run: `kungfu managed-run --provider … --prompt …`.
// The launcher is `kungfu` on PATH in a packaged runtime; KUNGFU_MANAGED_RUN_CMD
// overrides it so a source checkout can point at its built runtime.
function launchCommand(profile: RunProfile): {
  command: string;
  args: string[];
} {
  const env =
    typeof process !== 'undefined'
      ? process.env
      : ({} as Record<string, string>);
  const base = env.KUNGFU_MANAGED_RUN_CMD || 'kungfu';
  return {
    command: base,
    args: [
      'managed-run',
      '--provider',
      profile.provider,
      '--prompt',
      profile.prompt,
    ],
  };
}

// One pane on the canvas, bound to an already-created session by runId. The
// workspace owns creation (an event handler, not an effect) so a session is
// never spawned twice; a pane only attaches to it.
interface Pane {
  key: string;
  runId: string;
  title: string;
  provider: string;
  pid: number;
  startedAt: number;
  durable: boolean; // tmux-backed (survives close) vs direct
  // Retained so the pane can be persisted and re-adopted after a restart; the
  // surviving tmux session keeps its own process, these only label the record.
  command?: string;
  args?: string[];
  cwd?: string;
}

function providerChipStyle(provider: string): React.CSSProperties {
  const claude = provider === 'claude';
  return {
    ...mono,
    fontSize: 10.5,
    padding: '1px 7px',
    borderRadius: 999,
    color: claude ? '#c7a86a' : '#7fb4d8',
    background: claude ? 'rgba(199,168,106,0.14)' : 'rgba(127,180,216,0.14)',
    whiteSpace: 'nowrap',
  };
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

const iconButtonStyle: React.CSSProperties = {
  ...mono,
  fontSize: 11,
  cursor: 'pointer',
  color: '#cccccc',
  background: 'transparent',
  border: '1px solid #3a3a3a',
  borderRadius: 6,
  padding: '2px 8px',
};

// A single session pane: an xterm attached to `runId`. It never spawns or kills
// on mount/unmount — creation and teardown are explicit workspace actions — so
// navigating away or a StrictMode double-mount cannot leak or double-run a
// session. Unmount only detaches the local listeners and disposes the terminal;
// the session keeps running behind the capability.
function SessionPane({
  caps,
  pane,
  onDetach,
  onKill,
  onPopOut,
}: {
  caps: KfxCapabilities;
  pane: Pane;
  onDetach: (pane: Pane) => void;
  onKill: (pane: Pane) => void;
  // Present only when the shell can drive OS windows (ADR-0016 stage 2); the
  // pop-out affordance is hidden otherwise.
  onPopOut?: () => void;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [status, setStatus] = React.useState<string>('running');
  const [ended, setEnded] = React.useState(false);
  const [nowTs, setNowTs] = React.useState(() => pane.startedAt);

  React.useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const term = new XTerm({
      // Concrete font + integer size + explicit lineHeight so FitAddon's cell
      // measurement matches the actual render height; a fractional size (12.5)
      // let the two drift, so fit proposed ~2 more rows than fit the box and a
      // full-screen TUI's bottom rows (tmux's status line) were clipped.
      fontFamily: 'Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: { background: '#1a1a1a' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // fit needs a laid-out element; transient failures are harmless
      }
    };
    refit();

    let dataSub: { stop?: () => void } | undefined;
    let exitSub: { stop?: () => void } | undefined;

    void (async () => {
      try {
        // onData replays the session's buffered output first, so a pane that
        // attaches to a session already in flight (including a reattach) shows
        // its history before live output.
        dataSub = await resolve(
          caps.terminal.onData(pane.runId, (data: string) => term.write(data)),
        );
        exitSub = await resolve(
          caps.terminal.onExit(pane.runId, (exit) => {
            setStatus(`exited (${exit.exitCode})`);
            setEnded(true);
            term.write(
              `\r\n\x1b[90m[session ended: code ${exit.exitCode}]\x1b[0m\r\n`,
            );
          }),
        );
        term.onData((data) => {
          void resolve(caps.terminal.write(pane.runId, data)).catch(() => {
            // writing to an ended session throws; the exit listener already
            // surfaced the end, so swallow the race here
          });
        });
        term.onResize(({ cols, rows }) => {
          void resolve(caps.terminal.resize(pane.runId, cols, rows));
        });
      } catch (e) {
        setStatus('unavailable');
        term.write(
          `\r\n\x1b[31m[session unavailable: ${(e as Error).message}]\x1b[0m\r\n`,
        );
      }
    })();

    // Refit to the grid cell, not just the window: a pane resizes whenever the
    // canvas reflows (another pane added/removed, panel split moved). Observing
    // fires once with the settled size, which is what syncs the session away
    // from its spawn size — so a full-screen TUI (tmux) draws its status line at
    // the real bottom row. The fit's own resize event also propagates, but push
    // the session size explicitly here so a size that fit() considers unchanged
    // still reaches the pty.
    const syncSize = () => {
      refit();
      if (term.cols > 0 && term.rows > 0) {
        void resolve(caps.terminal.resize(pane.runId, term.cols, term.rows));
      }
    };
    const ro = new ResizeObserver(syncSize);
    ro.observe(el);

    return () => {
      ro.disconnect();
      dataSub?.stop?.();
      exitSub?.stop?.();
      term.dispose();
    };
  }, [caps.terminal, pane.runId]);

  // Elapsed-time tick; stops once the session ends.
  React.useEffect(() => {
    if (ended) return;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ended]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: 260,
        border: '1px solid #333',
        borderRadius: 8,
        background: '#1e1e1e',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 8px',
          borderBottom: '1px solid #2b2b2b',
          background: '#232323',
        }}
      >
        <span style={providerChipStyle(pane.provider)}>{pane.provider}</span>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <span
            style={{
              fontSize: 12,
              color: '#e6e6e6',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {pane.title}
          </span>
          <span style={{ ...mono, fontSize: 10, color: '#7a7a7a' }}>
            run {pane.runId} · pid {pane.pid} ·{' '}
            <span
              title={
                pane.durable
                  ? 'tmux-backed (survives close)'
                  : 'direct (no durability)'
              }
            >
              {pane.durable ? '● durable' : '○ direct'}
            </span>{' '}
            · {formatElapsed(nowTs - pane.startedAt)}
          </span>
        </div>
        <span
          style={{
            ...mono,
            fontSize: 10.5,
            color: ended ? '#c46b6b' : '#5bbf6a',
            whiteSpace: 'nowrap',
          }}
        >
          {status}
        </span>
        {onPopOut && (
          <button
            type="button"
            onClick={onPopOut}
            title="Open this session in its own window"
            style={iconButtonStyle}
          >
            Pop out
          </button>
        )}
        {!ended && pane.durable && (
          <button
            type="button"
            onClick={() => onDetach(pane)}
            title="Close this pane but keep the agent running (reattach later)"
            style={iconButtonStyle}
          >
            Detach
          </button>
        )}
        <button
          type="button"
          onClick={() => onKill(pane)}
          title={
            ended ? 'Remove this pane' : 'End the session and remove the pane'
          }
          style={{ ...iconButtonStyle, color: ended ? '#cccccc' : '#d98a8a' }}
        >
          {ended ? 'Close' : 'Kill'}
        </button>
      </div>
      <div
        ref={hostRef}
        style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}
      />
    </div>
  );
}

// Compact launcher: clicking a profile ADDS a pane (concurrent), it does not
// replace the canvas. The list is an overview, never the main interaction.
function LauncherStrip({
  onLaunch,
}: {
  onLaunch: (profile: RunProfile) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      }}
    >
      <span style={{ ...mono, fontSize: 11, color: '#858585' }}>launch:</span>
      {INBOX.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onLaunch(p)}
          title={p.prompt}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            ...mono,
            fontSize: 11.5,
            cursor: 'pointer',
            color: '#e6e6e6',
            background: '#2a2a2a',
            border: '1px solid #3a3a3a',
            borderRadius: 7,
            padding: '4px 9px',
          }}
        >
          <span style={providerChipStyle(p.provider)}>{p.provider}</span>
          {p.label.replace(/^.*·\s*/, '')}
          <span style={{ color: '#5bbf6a', fontWeight: 600 }}>+</span>
        </button>
      ))}
    </div>
  );
}

// Sessions that are alive-but-detached or dead-but-recorded and not currently on
// the canvas. Detached sessions reattach into a fresh pane; orphaned/ended ones
// can only be dismissed (killed to clear the record).
function RecoverableTray({
  sessions,
  onReattach,
  onDismiss,
  onRefresh,
}: {
  sessions: TerminalSession[];
  onReattach: (session: TerminalSession) => void;
  onDismiss: (session: TerminalSession) => void;
  onRefresh: () => void;
}) {
  return (
    <div style={{ ...panelStyle, padding: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...headingStyle, margin: 0 }}>
          recoverable sessions · {sessions.length}
        </span>
        <button type="button" onClick={onRefresh} style={iconButtonStyle}>
          Refresh
        </button>
      </div>
      {sessions.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 8,
          }}
        >
          {sessions.map((s) => {
            const detached = s.status === 'detached';
            return (
              <div
                key={s.runId}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 8px',
                  borderRadius: 7,
                  border: '1px solid #333',
                  background: '#232323',
                }}
              >
                <span style={providerChipStyle(s.provider ?? 'agent')}>
                  {s.provider ?? 'agent'}
                </span>
                <span style={{ ...mono, fontSize: 10.5, color: '#9a9a9a' }}>
                  {s.runId} · {s.status}
                </span>
                {detached ? (
                  <button
                    type="button"
                    onClick={() => onReattach(s)}
                    style={{ ...iconButtonStyle, color: '#7fb4d8' }}
                  >
                    Reattach
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => onDismiss(s)}
                    style={{ ...iconButtonStyle, color: '#d98a8a' }}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SessionWorkspace({
  caps,
  shell,
}: { caps: KfxCapabilities; shell: Shell }) {
  const [panes, setPanes] = React.useState<Pane[]>([]);
  const [recoverable, setRecoverable] = React.useState<TerminalSession[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);
  // The per-session OS window set (ADR-0016 stage 2). Seeded from the persisted
  // layout, then driven by the main process, which owns the real windows and
  // pushes a snapshot on every open/close/move; we mirror it back into the
  // layout. Empty and inert when the shell cannot drive windows (flag off /
  // sandbox), in which case the persisted windows are preserved untouched.
  const [windowRecords, setWindowRecords] = React.useState<PersistedWindow[]>(
    [],
  );
  // Persistence is gated on the domain capability; absent it the workspace is
  // ephemeral. `hydrated` blocks the save effect until the initial restore has
  // read the stored layout, so mounting never clobbers it with an empty set.
  const domain = caps.domain;
  const hydrated = React.useRef(false);

  const panedIds = React.useMemo(
    () => new Set(panes.map((p) => p.runId)),
    [panes],
  );

  // Restore on mount (W4): read the persisted layout and re-adopt each durable
  // session by runId. A session still alive on the tmux socket comes back
  // attached; a gone one is dropped (direct sessions cannot survive a restart).
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only restore; caps/domain/shell identity is stable per runtime
  React.useEffect(() => {
    if (!domain) {
      hydrated.current = true;
      return;
    }
    // Read synchronously before the save effect can run, so the stored layout
    // is captured even though adoption is async.
    const layout = loadWorkspaceLayout(domain);
    // Seed the window set so the first persist preserves it; the main process
    // then becomes the source of truth once it restores and emits a snapshot.
    setWindowRecords(layout.windows);
    let cancelled = false;
    void (async () => {
      const restored: Pane[] = [];
      for (const p of [...layout.panes].sort((a, b) => a.order - b.order)) {
        if (p.backend !== 'tmux') continue;
        try {
          const s = await resolve(
            caps.terminal.adopt({
              runId: p.runId,
              provider: p.provider,
              command: p.command,
              args: p.args,
              cwd: p.cwd,
            }),
          );
          if (s.status === 'running') {
            restored.push({
              key: s.runId,
              runId: s.runId,
              title: p.title,
              provider: p.provider,
              pid: s.pid,
              startedAt: p.startedAt || s.startedAt,
              durable: true,
              command: p.command,
              args: p.args,
              cwd: p.cwd,
            });
          }
        } catch {
          // un-adoptable (gone / no tmux) — leave it out of the restored set
        }
      }
      if (!cancelled) {
        if (restored.length > 0) setPanes(restored);
        // Restore only windows whose session actually came back; a window for a
        // gone session cannot show anything, so it is dropped. The main process
        // clamps each saved rectangle onto a present display (F7).
        const liveRunIds = new Set(restored.map((r) => r.runId));
        const liveWindows = layout.windows.filter((w) =>
          liveRunIds.has(w.runId),
        );
        if (liveWindows.length > 0) shell.restoreSessionWindows?.(liveWindows);
        hydrated.current = true;
        // the pane-set change triggers the tray refresh effect below; no need
        // to call refresh() here (it is declared later)
      }
    })();
    return () => {
      cancelled = true;
    };
    // run once on mount; caps/domain/shell identity is stable for a given runtime
  }, []);

  // Mirror the main process's live window set into our state so the persist
  // effect writes it into the layout. Inert when the shell cannot drive windows.
  React.useEffect(() => {
    return shell.onSessionWindowsSnapshot?.((windows) =>
      setWindowRecords(windows),
    );
  }, [shell]);

  // Persist on change (W4): once hydrated, mirror the live pane set and the
  // per-session window set into the config-backed layout so a restart can bring
  // the durable sessions and their windows back.
  React.useEffect(() => {
    if (!domain || !hydrated.current) return;
    const layout: WorkspaceLayout = {
      version: 1,
      workspaceId: 'default',
      panes: panes.map((p, i) => ({
        runId: p.runId,
        provider: p.provider,
        title: p.title,
        backend: p.durable ? 'tmux' : 'direct',
        command: p.command,
        args: p.args,
        cwd: p.cwd,
        startedAt: p.startedAt,
        order: i,
      })),
      windows: windowRecords,
    };
    saveWorkspaceLayout(domain, layout);
  }, [panes, domain, windowRecords]);

  const refresh = React.useCallback(async () => {
    try {
      // discover reconciles the known session map (marks truly-gone sessions
      // orphaned; a dead socket is left untouched), then list reflects it.
      await resolve(caps.terminal.discover()).catch(() => undefined);
      const all = await resolve(caps.terminal.list());
      setRecoverable(
        all.filter(
          (s) =>
            (s.status === 'detached' || s.status === 'orphaned') &&
            !panedIds.has(s.runId),
        ),
      );
    } catch {
      setRecoverable([]);
    }
  }, [caps.terminal, panedIds]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const launch = React.useCallback(
    async (profile: RunProfile) => {
      const { command, args } = launchCommand(profile);
      let session: TerminalSession;
      let durable = true;
      try {
        session = await resolve(
          caps.terminal.spawn({
            command,
            args,
            provider: profile.provider,
            backend: 'tmux',
            cols: 80,
            rows: 24,
          }),
        );
      } catch {
        // No tmux backend on this host: fall back to a direct (non-durable)
        // session so the workspace still works, and flag the pane as such.
        durable = false;
        setNotice(
          'no tmux backend — sessions run directly and do not survive close',
        );
        session = await resolve(
          caps.terminal.spawn({
            command,
            args,
            provider: profile.provider,
            cols: 80,
            rows: 24,
          }),
        );
      }
      setPanes((prev) => [
        ...prev,
        {
          key: session.runId,
          runId: session.runId,
          title: profile.label,
          provider: profile.provider,
          pid: session.pid,
          startedAt: session.startedAt,
          durable,
          command,
          args,
        },
      ]);
    },
    [caps.terminal],
  );

  const detachPane = React.useCallback(
    (pane: Pane) => {
      try {
        caps.terminal.detach(pane.runId);
      } catch {
        // a non-durable or already-ended session has nothing to detach
      }
      setPanes((prev) => prev.filter((p) => p.key !== pane.key));
      void refresh();
    },
    [caps.terminal, refresh],
  );

  const killPane = React.useCallback(
    (pane: Pane) => {
      try {
        caps.terminal.kill(pane.runId);
      } catch {
        // best-effort
      }
      setPanes((prev) => prev.filter((p) => p.key !== pane.key));
      void refresh();
    },
    [caps.terminal, refresh],
  );

  const reattach = React.useCallback(
    async (s: TerminalSession) => {
      try {
        const session = await resolve(caps.terminal.reattach(s.runId));
        setPanes((prev) =>
          prev.some((p) => p.runId === session.runId)
            ? prev
            : [
                ...prev,
                {
                  key: session.runId,
                  runId: session.runId,
                  title: `${session.provider ?? 'agent'} · ${session.command}`,
                  provider: session.provider ?? 'agent',
                  pid: session.pid,
                  startedAt: session.startedAt,
                  durable: true,
                  command: session.command,
                  args: session.args,
                  cwd: session.cwd,
                },
              ],
        );
      } catch (e) {
        setNotice(`reattach failed: ${(e as Error).message}`);
      }
      void refresh();
    },
    [caps.terminal, refresh],
  );

  const dismiss = React.useCallback(
    (s: TerminalSession) => {
      try {
        caps.terminal.kill(s.runId);
      } catch {
        // best-effort
      }
      void refresh();
    },
    [caps.terminal, refresh],
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: 8,
      }}
    >
      <LauncherStrip onLaunch={launch} />
      {notice && (
        <div style={{ ...mono, fontSize: 11, color: '#c9a227' }}>{notice}</div>
      )}
      <RecoverableTray
        sessions={recoverable}
        onReattach={reattach}
        onDismiss={dismiss}
        onRefresh={() => void refresh()}
      />
      {panes.length === 0 ? (
        <div
          style={{
            ...panelStyle,
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#6a6a6a',
            ...mono,
            fontSize: 12,
          }}
        >
          launch a session above — panes stack here, several visible at once
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            overflow: 'auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
            gridAutoRows: 'minmax(260px, 1fr)',
            gap: 10,
            alignContent: 'start',
          }}
        >
          {panes.map((pane) => (
            <SessionPane
              key={pane.key}
              caps={caps}
              pane={pane}
              onDetach={detachPane}
              onKill={killPane}
              onPopOut={
                shell.popOutSession
                  ? () => shell.popOutSession?.(pane.runId)
                  : undefined
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

// The content of a per-session OS window (ADR-0016 stage 3): it adopts one
// already-created session by runId over the shared main-process host and renders
// a single full-window pane, replacing the stage-2 placeholder page. It owns no
// launcher, tray, or layout persistence — the in-shell grid owns those; this
// window is only a view onto one session. Closing the window never ends the
// session (window identity is separate from session identity, ADR-0016): detach
// keeps the agent running and kill ends it, and either way the window closes.
function SingleSessionWindow({
  caps,
  runId,
}: { caps: KfxCapabilities; runId: string }) {
  const [pane, setPane] = React.useState<Pane | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // The session already exists on the shared host; just read its snapshot
        // to label the pane. The pane attaches to the live stream on its own.
        const session = await resolve(caps.terminal.get(runId));
        if (cancelled) return;
        if (!session) {
          setError(`session ${runId} is not on the host`);
          return;
        }
        setPane({
          key: session.runId,
          runId: session.runId,
          title: `${session.provider ?? 'agent'} · ${session.command}`,
          provider: session.provider ?? 'agent',
          pid: session.pid,
          startedAt: session.startedAt,
          durable: session.backend === 'tmux',
          command: session.command,
          args: session.args,
          cwd: session.cwd,
        });
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [caps.terminal, runId]);

  const frame: React.CSSProperties = {
    height: '100vh',
    boxSizing: 'border-box',
    padding: 8,
    background: '#1e1e1e',
  };

  if (error) {
    return (
      <div style={{ ...frame, ...mono, fontSize: 12, color: '#c46b6b' }}>
        {error}
      </div>
    );
  }
  if (!pane) {
    return (
      <div style={{ ...frame, ...mono, fontSize: 12, color: '#7a7a7a' }}>
        attaching to session {runId}…
      </div>
    );
  }
  return (
    // one grid cell that stretches the pane to fill the window, the same way the
    // in-shell grid stretches a cell — SessionPane needs a stretching parent
    <div
      style={{
        ...frame,
        display: 'grid',
        gridTemplateColumns: '1fr',
        gridTemplateRows: '1fr',
      }}
    >
      <SessionPane
        caps={caps}
        pane={pane}
        onDetach={(p) => {
          try {
            caps.terminal.detach(p.runId);
          } catch {
            // a direct (non-tmux) session has nothing to detach; close anyway
          }
          window.close();
        }}
        onKill={(p) => {
          try {
            caps.terminal.kill(p.runId);
          } catch {
            // best-effort; close the window regardless
          }
          window.close();
        }}
      />
    </div>
  );
}

// The kfx entry. In the shell it renders the full session workspace; opened as a
// per-session OS window (ADR-0016 stage 3) the renderer passes the target runId
// through `shell.params.sessionWindowRunId`, and it renders that one session.
function View({ caps, shell }: { caps: KfxCapabilities; shell: Shell }) {
  const runId = shell.params?.sessionWindowRunId;
  if (runId) return <SingleSessionWindow caps={caps} runId={runId} />;
  return <SessionWorkspace caps={caps} shell={shell} />;
}

export { View };
