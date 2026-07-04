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
// Out of scope here (later slices): real OS windows across monitors with saved
// display bounds (a gui main-process concern), cost/proof badges, and
// cross-restart layout persistence. This slice delivers in-view concurrency plus
// detach / discover / reattach against one running app.
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
}: {
  caps: KfxCapabilities;
  pane: Pane;
  onDetach: (pane: Pane) => void;
  onKill: (pane: Pane) => void;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [status, setStatus] = React.useState<string>('running');
  const [ended, setEnded] = React.useState(false);
  const [nowTs, setNowTs] = React.useState(() => pane.startedAt);

  React.useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const term = new XTerm({
      fontFamily: 'monospace',
      fontSize: 12.5,
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
    // canvas reflows (another pane added/removed, panel split moved).
    const ro = new ResizeObserver(refit);
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
      <div ref={hostRef} style={{ flex: 1, padding: 6, overflow: 'hidden' }} />
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

function SessionWorkspace({ caps }: { caps: KfxCapabilities; shell: Shell }) {
  const [panes, setPanes] = React.useState<Pane[]>([]);
  const [recoverable, setRecoverable] = React.useState<TerminalSession[]>([]);
  const [notice, setNotice] = React.useState<string | null>(null);

  const panedIds = React.useMemo(
    () => new Set(panes.map((p) => p.runId)),
    [panes],
  );

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
            />
          ))}
        </div>
      )}
    </div>
  );
}

export const View = SessionWorkspace;
