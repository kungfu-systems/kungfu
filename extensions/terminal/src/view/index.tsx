// Managed terminal — a PTY-backed terminal hosted inside the Kungfu GUI, so a
// user starts and interacts with a managed agent process without leaving Kungfu.
// The view is pure interaction UI: xterm.js for rendering and keyboard, and the
// declared `terminal` capability for the process. It never touches node-pty
// directly — the PTY host lives in the trusted renderer behind the capability
// boundary, so this view runs identically whether it is loaded node-integrated
// or in a locked sandbox reaching the capability over IPC.
//
// The capability is async at the sandbox boundary (an IPC hop cannot be
// synchronous); `resolve` awaits both the sync (node-integrated) and Promise
// (sandboxed-ipc) shapes so one code path serves both tiers.
//
// The view opens on an inbox of managed-run profiles. Picking one starts a
// managed provider run in the terminal, which reports its cost. The command is
// resolved from KUNGFU_MANAGED_RUN_CMD (a launcher on PATH in a packaged
// runtime); a dev override lets a source checkout point at its built runtime.
// Seeding the inbox in the view is MVP scope — importing real work/run cards
// from the runtime is a later slice.
import '@xterm/xterm/css/xterm.css';
import type { KfxCapabilities, Shell } from '@kungfu-tech/kfx';
import { mono, panelStyle } from '@kungfu-tech/kfx';
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

function providerChipStyle(provider: Provider): React.CSSProperties {
  const claude = provider === 'claude';
  return {
    ...mono,
    fontSize: 10.5,
    padding: '1px 7px',
    borderRadius: 999,
    color: claude ? '#c7a86a' : '#7fb4d8',
    background: claude ? 'rgba(199,168,106,0.14)' : 'rgba(127,180,216,0.14)',
  };
}

function Inbox({ onRun }: { onRun: (p: RunProfile) => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: 10,
      }}
    >
      <div style={{ ...mono, fontSize: 12, color: '#9cdcfe' }}>
        Managed-run inbox · pick a run to start
      </div>
      <div
        style={{
          ...panelStyle,
          flex: 1,
          padding: 10,
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {INBOX.map((p) => (
          <div
            key={p.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              borderRadius: 8,
              border: '1px solid #2b2b2b',
              background: '#232323',
            }}
          >
            <span style={providerChipStyle(p.provider)}>{p.provider}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: '#e6e6e6' }}>{p.label}</div>
              <div
                style={{
                  ...mono,
                  fontSize: 11,
                  color: '#8a8a8a',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {p.prompt}
              </div>
            </div>
            <button
              type="button"
              onClick={() => onRun(p)}
              style={{
                ...mono,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
                color: '#0f151b',
                background: '#3fb950',
                border: 'none',
                borderRadius: 7,
                padding: '6px 14px',
              }}
            >
              Run
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function RunTerminal({
  caps,
  profile,
  onBack,
}: {
  caps: KfxCapabilities;
  profile: RunProfile;
  onBack: () => void;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [status, setStatus] = React.useState('starting…');
  const [meta, setMeta] = React.useState<{ runId: string; pid: number } | null>(
    null,
  );

  React.useEffect(() => {
    const el = hostRef.current;
    if (!el) return;

    const term = new XTerm({
      fontFamily: 'monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#1e1e1e' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      // fit needs a laid-out element; a first-frame failure is harmless
    }

    let disposed = false;
    let dataSub: { stop?: () => void } | undefined;
    let exitSub: { stop?: () => void } | undefined;
    let activeRunId: string | undefined;

    void (async () => {
      try {
        const { command, args } = launchCommand(profile);
        const session = await resolve(
          caps.terminal.spawn({
            command,
            args,
            cols: term.cols,
            rows: term.rows,
          }),
        );
        if (disposed) {
          void resolve(caps.terminal.kill(session.runId));
          return;
        }
        activeRunId = session.runId;
        setMeta({ runId: session.runId, pid: session.pid });
        setStatus('running');

        dataSub = await resolve(
          caps.terminal.onData(session.runId, (data: string) =>
            term.write(data),
          ),
        );
        exitSub = await resolve(
          caps.terminal.onExit(session.runId, (exit) => {
            setStatus(`exited (${exit.exitCode})`);
            term.write(
              `\r\n\x1b[90m[process exited: code ${exit.exitCode}]\x1b[0m\r\n`,
            );
          }),
        );

        term.onData((data) => {
          void resolve(caps.terminal.write(session.runId, data));
        });
        term.onResize(({ cols, rows }) => {
          void resolve(caps.terminal.resize(session.runId, cols, rows));
        });
      } catch (e) {
        setStatus('unavailable');
        term.write(
          `\r\n\x1b[31m[terminal capability unavailable: ${
            (e as Error).message
          }]\x1b[0m\r\n`,
        );
      }
    })();

    const onWindowResize = () => {
      try {
        fit.fit();
      } catch {
        // ignore transient layout failures
      }
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onWindowResize);
      dataSub?.stop?.();
      exitSub?.stop?.();
      if (activeRunId) {
        try {
          void resolve(caps.terminal.kill(activeRunId));
        } catch {
          // best-effort teardown
        }
      }
      term.dispose();
    };
  }, [caps.terminal, profile]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: 6,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          ...mono,
          fontSize: 12,
          color: '#9cdcfe',
        }}
      >
        <button
          type="button"
          onClick={onBack}
          style={{
            ...mono,
            fontSize: 11,
            cursor: 'pointer',
            color: '#9cdcfe',
            background: 'transparent',
            border: '1px solid #3a3a3a',
            borderRadius: 6,
            padding: '2px 8px',
          }}
        >
          ← Inbox
        </button>
        <span>
          {profile.provider} · {profile.label}
          {meta ? ` · run ${meta.runId} · pid ${meta.pid}` : ''} · {status}
        </span>
      </div>
      <div
        ref={hostRef}
        style={{ ...panelStyle, flex: 1, padding: 6, overflow: 'hidden' }}
      />
    </div>
  );
}

function TerminalView({ caps }: { caps: KfxCapabilities; shell: Shell }) {
  const [active, setActive] = React.useState<RunProfile | null>(null);
  return active ? (
    <RunTerminal caps={caps} profile={active} onBack={() => setActive(null)} />
  ) : (
    <Inbox onRun={setActive} />
  );
}

export const View = TerminalView;
