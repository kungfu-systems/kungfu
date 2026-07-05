// Main-process managed session host (ADR-0016 stage 1). The durable session
// host — node-pty plus the tmux backend — runs here, in the app-lifetime main
// process, so it outlives any single window and (later) is reachable from every
// window. Renderers reach it over a terminal-specific relay (see
// terminal-channels): a per-subscription stop() round-trips, which the shared
// capability relay does not do and which the terminal's churning onData/onExit
// subscriptions require.
//
// This is gated by KF_TERMINAL_HOST=main; the default keeps the in-renderer
// host, so the working single-window app is untouched until this path is
// validated on a real machine.
//
// The relay core (createTerminalRelay) is pure and contract-testable; the
// ipcMain glue (bindElectronTerminalHost) is the thin electron-only shell, the
// same split sandbox-host.ts uses.
import {
  type PtyModule,
  type Subscription,
  type Terminal,
  type TmuxBinding,
  openTerminal,
} from '@kungfu-tech/api/capability';

import {
  TERMINAL_CALL_CHANNEL,
  TERMINAL_EVENT_CHANNEL,
  TERMINAL_SUBSCRIBE_CHANNEL,
  TERMINAL_UNSUBSCRIBE_CHANNEL,
} from '../sandbox/channels';

// Resolve an absolute tmux binary + isolated socket in the main process (node,
// so require('node:*') is available directly — no window.require shim). Returns
// null when no tmux is present; the host then runs sessions directly.
function resolveTmuxBinding(): TmuxBinding | null {
  try {
    // Minimal local shapes rather than `typeof import('…')`, whose formatted
    // multiline form is fragile; we need only existsSync and execFile.
    const fs = require('node:fs') as {
      existsSync: (p: string) => boolean;
    };
    const cp = require('node:child_process') as {
      execFile: (
        file: string,
        args: string[],
        options: { encoding: 'utf8' },
        cb: (
          err: (Error & { code?: number }) | null,
          stdout: string,
          stderr: string,
        ) => void,
      ) => void;
    };
    const socket = process.env.KF_TMUX_SOCKET || 'kungfu-managed';
    const candidates = [
      process.env.KF_TMUX_BIN,
      '/opt/homebrew/bin/tmux',
      '/usr/local/bin/tmux',
      '/usr/bin/tmux',
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);
    const bin = candidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
    if (!bin) return null;
    return {
      config: { socket, bin },
      control: {
        run: (args) =>
          new Promise((resolve) => {
            cp.execFile(
              bin,
              args,
              { encoding: 'utf8' },
              (err, stdout, stderr) => {
                const code =
                  err && typeof (err as { code?: unknown }).code === 'number'
                    ? (err as { code: number }).code
                    : err
                      ? 1
                      : 0;
                resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
              },
            );
          }),
      },
    };
  } catch {
    return null;
  }
}

export function createMainTerminalHost(): Terminal {
  const pty = require('node-pty') as PtyModule;
  const tmux = resolveTmuxBinding() ?? undefined;
  return openTerminal({
    pty,
    tmux,
    baseEnv: process.env as Record<string, string | undefined>,
  });
}

// ── pure relay core ─────────────────────────────────────────────────────────

type SubscribeMethod = 'onData' | 'onExit';

// Wire a Terminal host behind three transport verbs. `call` dispatches a value
// method; `subscribe` opens an onData/onExit stream whose events are pushed via
// the per-subscription `emit`; `unsubscribe` releases exactly that stream. The
// subId is minted by the guest, so stop() on the guest maps back to one stream.
//
// Subscriptions are keyed by `<clientKey>:<subId>`, not by subId alone: since
// ADR-0016 stage 3 the shell and each per-session OS window are separate guest
// renderers reaching this one host, and each mints its own subId sequence from
// scratch. Keyed by subId alone, the second guest's subId 1 would evict the
// first guest's subId 1 (the defensive replace below), silently killing an
// unrelated live pane. The clientKey (the sender's webContents id, supplied by
// the glue) namespaces those sequences so guests never collide.
export function createTerminalRelay(host: Terminal) {
  const subs = new Map<string, Subscription>();
  const subKey = (clientKey: string, subId: number) => `${clientKey}:${subId}`;
  return {
    async call(method: string, args: unknown[]): Promise<unknown> {
      const fn = (host as unknown as Record<string, unknown>)[method];
      if (typeof fn !== 'function') {
        throw new Error(`terminal has no method '${method}'`);
      }
      return await (fn as (...a: unknown[]) => unknown).apply(host, args);
    },
    subscribe(
      clientKey: string,
      method: SubscribeMethod,
      runId: string,
      subId: number,
      emit: (args: unknown[]) => void,
    ): void {
      const key = subKey(clientKey, subId);
      // replace any prior stream on this key (defensive; a guest's ids are
      // unique within itself, and the clientKey separates guests)
      subs.get(key)?.stop();
      const sub =
        method === 'onExit'
          ? host.onExit(runId, (exit) => emit([exit]))
          : host.onData(runId, (data) => emit([data]));
      subs.set(key, sub);
    },
    unsubscribe(clientKey: string, subId: number): void {
      const key = subKey(clientKey, subId);
      subs.get(key)?.stop();
      subs.delete(key);
    },
    // Release every stream a guest holds when its webContents goes away without
    // unsubscribing (a session window closed abruptly): the host must neither
    // leak the subscriptions nor keep emitting into a destroyed sender.
    unsubscribeClient(clientKey: string): void {
      const prefix = `${clientKey}:`;
      for (const [key, sub] of subs) {
        if (key.startsWith(prefix)) {
          sub.stop();
          subs.delete(key);
        }
      }
    },
    dispose(): void {
      for (const sub of subs.values()) sub.stop();
      subs.clear();
    },
  };
}

// ── electron glue ───────────────────────────────────────────────────────────

type TerminalInvokeEvent = {
  // The subscribing renderer's webContents. `id` namespaces this guest's subId
  // sequence in the relay (ADR-0016 stage 3 gives the shell and every session
  // window their own sequence); `isDestroyed`/`once('destroyed')` let the host
  // stop emitting into — and release the streams of — a window that closed.
  sender: {
    id: number;
    send: (channel: string, payload: unknown) => void;
    isDestroyed?: () => boolean;
    once?: (event: 'destroyed', listener: () => void) => void;
  };
};

type IpcMainLike = {
  handle: (
    channel: string,
    listener: (event: TerminalInvokeEvent, ...args: unknown[]) => unknown,
  ) => void;
  removeHandler: (channel: string) => void;
};

export function bindElectronTerminalHost(ipcMain: IpcMainLike, host: Terminal) {
  const relay = createTerminalRelay(host);
  // guests we have wired a destroyed-cleanup for, so we register it once each
  const cleanupWired = new Set<number>();
  ipcMain.handle(TERMINAL_CALL_CHANNEL, (_event, payload) => {
    const { method, args } = payload as { method: string; args: unknown[] };
    return relay.call(method, args);
  });
  ipcMain.handle(TERMINAL_SUBSCRIBE_CHANNEL, (event, payload) => {
    const { method, runId, subId } = payload as {
      method: SubscribeMethod;
      runId: string;
      subId: number;
    };
    const sender = event.sender;
    const clientKey = String(sender.id);
    // A per-session window can close without its React cleanup running (the
    // whole webContents is torn down); release every stream it held so the host
    // stops emitting into a dead sender and does not leak.
    if (!cleanupWired.has(sender.id)) {
      cleanupWired.add(sender.id);
      sender.once?.('destroyed', () => {
        relay.unsubscribeClient(clientKey);
        cleanupWired.delete(sender.id);
      });
    }
    // events go back to the renderer that subscribed
    relay.subscribe(clientKey, method, runId, subId, (args) => {
      if (sender.isDestroyed?.()) return;
      sender.send(TERMINAL_EVENT_CHANNEL, { subId, args });
    });
    return undefined;
  });
  ipcMain.handle(TERMINAL_UNSUBSCRIBE_CHANNEL, (event, payload) => {
    const { subId } = payload as { subId: number };
    relay.unsubscribe(String(event.sender.id), subId);
    return undefined;
  });
  return {
    dispose() {
      relay.dispose();
      ipcMain.removeHandler(TERMINAL_CALL_CHANNEL);
      ipcMain.removeHandler(TERMINAL_SUBSCRIBE_CHANNEL);
      ipcMain.removeHandler(TERMINAL_UNSUBSCRIBE_CHANNEL);
    },
  };
}
