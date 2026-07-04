// Managed terminal — a PTY-backed terminal hosted inside the Kungfu GUI, so a
// user interacts with a managed agent process without leaving Kungfu. The view
// is pure interaction UI: xterm.js for rendering and keyboard, and the declared
// `terminal` capability for the process. It never touches node-pty directly —
// the PTY host lives in the trusted renderer behind the capability boundary, so
// this view runs identically whether it is loaded node-integrated or in a
// locked sandbox reaching the capability over IPC.
//
// The capability is async at the sandbox boundary (an IPC hop cannot be
// synchronous); `resolve` awaits both the sync (node-integrated) and Promise
// (sandboxed-ipc) shapes so one code path serves both tiers. A sandboxed
// subscription has no local stop(); it is released when the view unmounts and
// the shell disposes the capability host — so cleanup calls stop() when present
// and relies on host disposal otherwise.
//
// MVP scope: this auto-starts one login shell to prove the PTY + xterm + run
// binding end to end. Choosing the provider (codex/claude) from a work/run
// inbox is a later slice, not this one.
import '@xterm/xterm/css/xterm.css';
import type { KfxCapabilities, Shell } from '@kungfu-tech/kfx';
import { mono, panelStyle } from '@kungfu-tech/kfx';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import React from 'react';

async function resolve<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

function TerminalView({ caps }: { caps: KfxCapabilities; shell: Shell }) {
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
        const session = await resolve(
          caps.terminal.spawn({
            command: '/bin/bash',
            args: ['-l'],
            cols: term.cols,
            rows: term.rows,
          }),
        );
        // the effect was torn down while spawn was in flight — do not leak the pty
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
  }, [caps.terminal]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        gap: 6,
      }}
    >
      <div style={{ ...mono, fontSize: 12, color: '#9cdcfe' }}>
        Terminal{meta ? ` · run ${meta.runId} · pid ${meta.pid}` : ''} ·{' '}
        {status}
      </div>
      <div
        ref={hostRef}
        style={{ ...panelStyle, flex: 1, padding: 6, overflow: 'hidden' }}
      />
    </div>
  );
}

export const View = TerminalView;
