// Terminal-domain capability handle: a PTY host that owns managed agent
// processes and binds each to a run. Factory-style, no import-time side
// effects, same shape as the other capability handles (ADR-0011).
//
// Trust/placement: this handle lives in the trusted renderer (it needs node +
// a native addon — node-pty — exactly like the kungfu binding). A sandboxed
// kfx reaches it only through its declared `terminal` capability, marshalled
// over IPC. Because a sandboxed view codes against a Promise surface and its
// callbacks are bridged, `onData`/`onExit` follow the Subscription `{stop}`
// convention the sandbox layer already understands — a bridged callback plus a
// retained subscription, no terminal-specific transport.
//
// node-pty is injected (PtyModule), not imported, so the SDK stays
// binding-agnostic and testable without a real pty. The trusted renderer wires
// in `window.require('node-pty')`.
import type { Subscription } from './types.js';

// --- injected node-pty surface (the minimal subset this handle needs) ------

export interface PtyDisposable {
  dispose(): void;
}

export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): PtyDisposable;
  onExit(
    cb: (event: { exitCode: number; signal?: number }) => void,
  ): PtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: PtySpawnOptions,
  ): PtyProcess;
}

// --- public surface ---------------------------------------------------------

export type TerminalSpawnOptions = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
  // The managed-run identity this terminal serves. A caller that already owns a
  // run (supervisor-assigned) passes runId; otherwise the host mints one. workId
  // is the higher-level work item the run belongs to.
  runId?: string;
  workId?: string;
};

export type TerminalSession = {
  runId: string;
  pid: number;
  workId?: string;
  command: string;
  args: string[];
  cwd?: string;
  startedAt: number; // epoch ms
  status: 'running' | 'exited';
  exitCode?: number;
  exitSignal?: number;
  endedAt?: number;
};

export type TerminalExit = {
  runId: string;
  exitCode: number;
  signal?: number;
};

export type Terminal = {
  // Start a managed process bound to a run. Returns the session snapshot; the
  // run is addressable by runId for every other method.
  spawn: (options: TerminalSpawnOptions) => TerminalSession;
  // Feed stdin. No-op-safe? No: an unknown/exited run throws, so a caller never
  // silently writes into the void.
  write: (runId: string, data: string) => void;
  resize: (runId: string, cols: number, rows: number) => void;
  // Signal the process. Default SIGHUP mirrors node-pty; the process still gets
  // a final exit event and a recorded end state.
  kill: (runId: string, signal?: string) => void;
  // Subscribe to output. The already-buffered output is replayed to this
  // listener first (so a GUI that attaches late — or reattaches after a
  // refresh — sees the whole session), then live data streams. Returns a
  // Subscription; stop() detaches this listener only.
  onData: (runId: string, onData: (data: string) => void) => Subscription;
  // Subscribe to termination. If the run already exited, the listener fires
  // immediately with the recorded exit, then the subscription is inert.
  onExit: (runId: string, onExit: (exit: TerminalExit) => void) => Subscription;
  // All sessions this host knows, running and exited, newest last.
  list: () => TerminalSession[];
  get: (runId: string) => TerminalSession | undefined;
};

export type OpenTerminalOptions = {
  pty: PtyModule;
  // Injected for determinism in tests; defaults avoid crypto/import-time deps.
  makeRunId?: () => string;
  now?: () => number;
  // Per-session output buffer cap. Output beyond this is dropped from the FRONT
  // (a long run keeps its tail, which is what a late attach wants). 0 disables
  // buffering. Default 256 KiB.
  maxBufferBytes?: number;
  // Base environment merged under each spawn's env (the trusted renderer passes
  // its process.env so a spawned shell inherits PATH etc.); a spawn's own env
  // overrides it. A sandboxed view sends no env, so this is where PATH comes
  // from.
  baseEnv?: Record<string, string | undefined>;
};

const DEFAULT_MAX_BUFFER = 256 * 1024;

type Session = {
  meta: TerminalSession;
  pty: PtyProcess;
  buffer: string;
  dataListeners: Set<(data: string) => void>;
  exitListeners: Set<(exit: TerminalExit) => void>;
};

export function openTerminal(options: OpenTerminalOptions): Terminal {
  const { pty } = options;
  const now = options.now ?? (() => Date.now());
  const maxBuffer = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER;
  let seq = 0;
  const makeRunId =
    options.makeRunId ??
    (() => {
      seq += 1;
      return `pty-${now()}-${seq}`;
    });

  const sessions = new Map<string, Session>();

  const require_ = (runId: string): Session => {
    const session = sessions.get(runId);
    if (!session) throw new Error(`no terminal run '${runId}'`);
    return session;
  };

  const appendBuffer = (session: Session, data: string) => {
    if (maxBuffer <= 0) return;
    session.buffer += data;
    if (session.buffer.length > maxBuffer) {
      // keep the tail — a late attach cares about recent output
      session.buffer = session.buffer.slice(session.buffer.length - maxBuffer);
    }
  };

  const spawn: Terminal['spawn'] = (spawnOptions) => {
    if (!spawnOptions.command)
      throw new Error('terminal.spawn requires a command');
    const runId = spawnOptions.runId ?? makeRunId();
    if (sessions.has(runId))
      throw new Error(`terminal run '${runId}' already exists`);
    const args = spawnOptions.args ?? [];

    // node-pty wants a string map; merge the injected base env (PATH etc.) under
    // the spawn's own env, dropping undefined values.
    const env: Record<string, string> = {};
    for (const source of [options.baseEnv, spawnOptions.env]) {
      for (const [k, v] of Object.entries(source ?? {})) {
        if (typeof v === 'string') env[k] = v;
      }
    }

    const child = pty.spawn(spawnOptions.command, args, {
      name: 'xterm-color',
      cols: spawnOptions.cols ?? 80,
      rows: spawnOptions.rows ?? 24,
      cwd: spawnOptions.cwd,
      env: Object.keys(env).length > 0 ? env : undefined,
    });

    const meta: TerminalSession = {
      runId,
      pid: child.pid,
      workId: spawnOptions.workId,
      command: spawnOptions.command,
      args,
      cwd: spawnOptions.cwd,
      startedAt: now(),
      status: 'running',
    };
    const session: Session = {
      meta,
      pty: child,
      buffer: '',
      dataListeners: new Set(),
      exitListeners: new Set(),
    };
    sessions.set(runId, session);

    child.onData((data) => {
      appendBuffer(session, data);
      for (const listener of session.dataListeners) listener(data);
    });
    child.onExit(({ exitCode, signal }) => {
      session.meta.status = 'exited';
      session.meta.exitCode = exitCode;
      session.meta.exitSignal = signal;
      session.meta.endedAt = now();
      const exit: TerminalExit = { runId, exitCode, signal };
      for (const listener of session.exitListeners) listener(exit);
    });

    return { ...meta };
  };

  const write: Terminal['write'] = (runId, data) => {
    const session = require_(runId);
    if (session.meta.status === 'exited') {
      throw new Error(`terminal run '${runId}' has exited`);
    }
    session.pty.write(data);
  };

  const resize: Terminal['resize'] = (runId, cols, rows) => {
    const session = require_(runId);
    if (session.meta.status === 'exited') return;
    session.pty.resize(cols, rows);
  };

  const kill: Terminal['kill'] = (runId, signal) => {
    const session = require_(runId);
    if (session.meta.status === 'exited') return;
    session.pty.kill(signal);
  };

  const onData: Terminal['onData'] = (runId, listener) => {
    const session = require_(runId);
    // replay what the session has produced so far, then stream live
    if (session.buffer.length > 0) listener(session.buffer);
    session.dataListeners.add(listener);
    return { stop: () => session.dataListeners.delete(listener) };
  };

  const onExit: Terminal['onExit'] = (runId, listener) => {
    const session = require_(runId);
    if (session.meta.status === 'exited') {
      listener({
        runId,
        exitCode: session.meta.exitCode ?? 0,
        signal: session.meta.exitSignal,
      });
      return { stop: () => {} };
    }
    session.exitListeners.add(listener);
    return { stop: () => session.exitListeners.delete(listener) };
  };

  const list: Terminal['list'] = () =>
    Array.from(sessions.values()).map((s) => ({ ...s.meta }));

  const get: Terminal['get'] = (runId) => {
    const session = sessions.get(runId);
    return session ? { ...session.meta } : undefined;
  };

  return { spawn, write, resize, kill, onData, onExit, list, get };
}
