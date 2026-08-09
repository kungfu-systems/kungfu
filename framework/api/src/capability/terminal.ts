// Terminal-domain capability handle: a PTY host that owns managed agent
// processes and binds each to a run. Factory-style, no import-time side
// effects, same shape as the other capability handles (KF-ADR-019f86da-4f90-7e5e-ae22-2a8fc24086f1).
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
//
// Durability backend (W2/W3): a session may run its process directly under the
// pty (`backend: 'direct'`, the default and the original behaviour) or behind a
// tmux server on a dedicated, isolated socket (`backend: 'tmux'`). The tmux
// backend is what lets a managed agent survive GUI close/crash and be
// reattached after a restart. tmux is only a *backend* — the product model
// never speaks "tmux"; the Kungfu session registry is the authoritative
// mapping and this handle exposes a backend-agnostic surface. Like node-pty,
// the non-interactive tmux control channel is injected (TmuxControl), so the
// SDK stays binding-agnostic and testable without a real tmux.
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

// --- injected tmux surface (durability backend) -----------------------------

// A dedicated tmux socket + binary. The socket name isolates every Kungfu
// managed session from the user's own default-socket tmux sessions: all tmux
// commands carry `-L <socket>`, so they physically cannot reach the default
// socket. `bin` is an absolute tmux path (a non-interactive shell must not rely
// on a shell function shim).
export interface TmuxConfig {
  socket: string;
  bin: string;
}

export interface TmuxRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

// The non-interactive tmux control channel (list/kill/has-session). Interactive
// attach/create still goes through the pty; this is only for control commands
// that must run to completion and report an exit code. The trusted renderer
// wires in a child_process.execFile-backed implementation.
export interface TmuxControl {
  run(args: string[]): Promise<TmuxRunResult>;
}

export interface TmuxBinding {
  config: TmuxConfig;
  control: TmuxControl;
}

// --- pure tmux helpers (testable, reusable, no side effects) ----------------

// tmux session names may not contain '.' or ':' or whitespace; keep a readable,
// stable, collision-resistant token derived from the input.
const sanitizeTmuxToken = (value: string): string =>
  value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

// Deterministic tmux session name for a managed run. Determinism is what makes
// reattach work: after a restart the caller reconstructs runId from the
// registry, computes the same name, and `new-session -A` attaches to the
// surviving session instead of creating a new one.
export function tmuxSessionName(provider: string, runId: string): string {
  return `kf_${sanitizeTmuxToken(provider)}_${sanitizeTmuxToken(runId)}`;
}

// The managed tmux socket, derived from the runtime home. A tmux server freezes
// its environment at creation, so a single shared socket lets a server started
// by one runtime home leak its KF_RUNTIME_DIR / launcher into a managed session
// created later by a *different* home (the session inherits the server's stale
// env, and cost/journal facts land in the wrong home). Keying the socket on the
// home makes each server belong to exactly one home, so its frozen env can only
// ever be that home's. Deterministic, so a restart with the same home reattaches
// to the same server. An empty home keeps the legacy name. This module is shared
// browser/node, so the hash is a dependency-free djb2 rather than node:crypto.
export function managedTmuxSocket(runtimeDir: string): string {
  const home = runtimeDir.trim();
  if (!home) return 'kungfu-managed';
  let hash = 5381;
  for (let i = 0; i < home.length; i++) {
    hash = ((hash << 5) + hash + home.charCodeAt(i)) >>> 0;
  }
  return `kungfu-managed-${hash.toString(16).padStart(8, '0')}`;
}

// `new-session -A`: attach-or-create. When the named session already exists this
// behaves like attach-session (command is ignored — the running agent is
// untouched), which is exactly the W3 reattach path. Otherwise it creates the
// session and runs `command args` as its first window. `-x/-y` seed the initial
// size on creation.
export function buildTmuxNewSessionArgs(
  config: TmuxConfig,
  name: string,
  command: string,
  args: string[],
  cols: number,
  rows: number,
): string[] {
  return [
    '-L',
    config.socket,
    'new-session',
    '-A',
    '-s',
    name,
    '-x',
    String(cols),
    '-y',
    String(rows),
    command,
    ...args,
  ];
}

export function buildTmuxKillSessionArgs(
  config: TmuxConfig,
  name: string,
): string[] {
  return ['-L', config.socket, 'kill-session', '-t', name];
}

export function buildTmuxListArgs(config: TmuxConfig): string[] {
  return ['-L', config.socket, 'list-sessions', '-F', '#{session_name}'];
}

export function buildTmuxHasSessionArgs(
  config: TmuxConfig,
  name: string,
): string[] {
  return ['-L', config.socket, 'has-session', '-t', name];
}

// --- public surface ---------------------------------------------------------

export type TerminalBackend = 'direct' | 'tmux';

export type TerminalBackendDetail = {
  kind: 'tmux';
  socket: string;
  tmuxName: string;
};

// Lifecycle states:
//  - running:  process alive, a pty client is attached
//  - detached: (tmux only) session alive on the server, no client attached —
//              reattachable; the agent keeps running
//  - orphaned: (tmux only) we owned the session but the server says it is gone
//              and we did not kill it — it died outside our control, not
//              reattachable, and distinct from a clean commanded exit
//  - exited:   process/session ended (clean exit, or after our kill)
export type TerminalStatus = 'running' | 'detached' | 'orphaned' | 'exited';

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
  // Durability backend. Defaults to 'direct' (original behaviour). 'tmux'
  // requires openTerminal to have been given a tmux binding.
  backend?: TerminalBackend;
  // Agent provider label (e.g. 'codex', 'claude'), used for the tmux session
  // name and carried on the session snapshot.
  provider?: string;
};

export type TerminalSession = {
  runId: string;
  pid: number;
  workId?: string;
  provider?: string;
  command: string;
  args: string[];
  cwd?: string;
  startedAt: number; // epoch ms
  status: TerminalStatus;
  backend: TerminalBackend;
  backendDetail?: TerminalBackendDetail;
  exitCode?: number;
  exitSignal?: number;
  endedAt?: number;
};

export type TerminalExit = {
  runId: string;
  exitCode: number;
  signal?: number;
};

// A tmux session found on the managed socket. `owned` means this host has it in
// its session map (so it can be addressed by runId); an un-owned live session is
// one a previous process left behind and can be adopted via reattach.
export type DiscoveredSession = {
  tmuxName: string;
  owned: boolean;
  attached: boolean;
  runId?: string;
  provider?: string;
};

// Enough persisted identity to re-adopt a session the host did not create this
// run — a workspace restoring after an app restart, when the in-memory session
// map is empty but the tmux session may still be alive on the socket. runId +
// provider recompute the deterministic tmux name; command/args/cwd only label
// the restored snapshot (the surviving session keeps its own running process).
export type AdoptSpec = {
  runId: string;
  provider?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  cols?: number;
  rows?: number;
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
  // a final exit event and a recorded end state. For a tmux session this kills
  // the server-side session (the agent really dies), not just the client.
  kill: (runId: string, signal?: string) => void;
  // Detach a tmux session's client without killing the agent: the process keeps
  // running on the tmux server and the session becomes 'detached' and
  // reattachable. This is what "close the GUI window" maps to. Throws for a
  // direct-backend run, which has nothing to detach.
  detach: (runId: string) => void;
  // Subscribe to output. The already-buffered output is replayed to this
  // listener first (so a GUI that attaches late — or reattaches after a
  // refresh — sees the whole session), then live data streams. Returns a
  // Subscription; stop() detaches this listener only.
  onData: (runId: string, onData: (data: string) => void) => Subscription;
  // Subscribe to termination. If the run already exited, the listener fires
  // immediately with the recorded exit, then the subscription is inert. A
  // detach does NOT fire this — detach is not termination.
  onExit: (runId: string, onExit: (exit: TerminalExit) => void) => Subscription;
  // List tmux sessions on the managed socket and reconcile the known session
  // map against them (F6: only conclude a known session is orphaned when the
  // server answered and its name is absent; a dead socket/server is 'unknown'
  // and leaves statuses untouched). Requires a tmux binding.
  discover: () => Promise<DiscoveredSession[]>;
  // Reattach a live-but-detached tmux session with a fresh client. Guards with
  // has-session so a gone session is never silently recreated (which would
  // re-run the agent command). Requires a tmux binding.
  reattach: (runId: string) => Promise<TerminalSession>;
  // Re-adopt a persisted session after a restart: register a runId the host did
  // not create this run and attach to its surviving tmux session. If the tmux
  // session is gone it returns an 'orphaned' snapshot WITHOUT registering it (so
  // a caller can drop it), rather than recreating and re-running the command.
  // Requires a tmux binding.
  adopt: (spec: AdoptSpec) => Promise<TerminalSession>;
  // All sessions this host knows, running and exited, newest last.
  list: () => TerminalSession[];
  get: (runId: string) => TerminalSession | undefined;
};

export type OpenTerminalOptions = {
  pty: PtyModule;
  // The tmux durability backend. Only required when a spawn asks for
  // `backend: 'tmux'` (or when calling detach/discover/reattach on tmux runs).
  tmux?: TmuxBinding;
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
  cols: number;
  rows: number;
  tmuxName?: string;
  // What we asked for, so the pty's onExit can tell a commanded detach/kill from
  // an unexpected client death.
  intent?: 'detach' | 'kill';
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

  const requireTmux = (op: string): TmuxBinding => {
    if (!options.tmux)
      throw new Error(`terminal.${op} requires openTerminal({ tmux })`);
    return options.tmux;
  };

  const buildEnv = (
    extra?: Record<string, string | undefined>,
  ): Record<string, string> | undefined => {
    // node-pty wants a string map; merge the injected base env (PATH etc.) under
    // the spawn's own env, dropping undefined values.
    const env: Record<string, string> = {};
    for (const source of [options.baseEnv, extra]) {
      for (const [k, v] of Object.entries(source ?? {})) {
        if (typeof v === 'string') env[k] = v;
      }
    }
    return Object.keys(env).length > 0 ? env : undefined;
  };

  const appendBuffer = (session: Session, data: string) => {
    if (maxBuffer <= 0) return;
    session.buffer += data;
    if (session.buffer.length > maxBuffer) {
      // keep the tail — a late attach cares about recent output
      session.buffer = session.buffer.slice(session.buffer.length - maxBuffer);
    }
  };

  const finalizeExit = (
    session: Session,
    exitCode: number,
    signal: number | undefined,
    status: 'exited' | 'orphaned' = 'exited',
  ) => {
    session.meta.status = status;
    session.meta.exitCode = exitCode;
    session.meta.exitSignal = signal;
    session.meta.endedAt = now();
    session.intent = undefined;
    const exit: TerminalExit = { runId: session.meta.runId, exitCode, signal };
    for (const listener of session.exitListeners) listener(exit);
  };

  // Wire a (possibly fresh, after reattach) pty child's data/exit into a
  // session. Kept separate so spawn and reattach share exactly one handler.
  const wireChild = (session: Session, child: PtyProcess) => {
    child.onData((data) => {
      appendBuffer(session, data);
      for (const listener of session.dataListeners) listener(data);
    });
    child.onExit(({ exitCode, signal }) => {
      if (session.meta.backend !== 'tmux') {
        // direct backend: the client IS the process; its exit is the end
        finalizeExit(session, exitCode, signal);
        return;
      }
      if (session.intent === 'detach') {
        // commanded detach: the tmux session lives on, agent keeps running
        session.meta.status = 'detached';
        session.intent = undefined;
        return;
      }
      if (session.intent === 'kill') {
        finalizeExit(session, exitCode, signal);
        return;
      }
      // Unexpected client exit. It could be a detach-by-signal (session alive)
      // or a genuine end (session gone). Ask the server rather than guess (F6).
      const tmux = options.tmux;
      if (tmux && session.tmuxName) {
        void tmux.control
          .run(buildTmuxHasSessionArgs(tmux.config, session.tmuxName))
          .then(({ code }) => {
            if (code === 0) {
              // survived: reattachable
              session.meta.status = 'detached';
            } else {
              // gone but we didn't kill it: it died outside our control
              finalizeExit(session, exitCode, signal, 'orphaned');
            }
          })
          .catch(() => finalizeExit(session, exitCode, signal, 'orphaned'));
      } else {
        finalizeExit(session, exitCode, signal, 'orphaned');
      }
    });
  };

  const spawn: Terminal['spawn'] = (spawnOptions) => {
    if (!spawnOptions.command)
      throw new Error('terminal.spawn requires a command');
    const runId = spawnOptions.runId ?? makeRunId();
    if (sessions.has(runId))
      throw new Error(`terminal run '${runId}' already exists`);
    const args = spawnOptions.args ?? [];
    const cols = spawnOptions.cols ?? 80;
    const rows = spawnOptions.rows ?? 24;
    const backend: TerminalBackend = spawnOptions.backend ?? 'direct';

    // Decide what the pty actually launches: the command directly, or a tmux
    // attach-or-create client that owns it.
    let file = spawnOptions.command;
    let ptyArgs = args;
    let tmuxName: string | undefined;
    let backendDetail: TerminalBackendDetail | undefined;
    if (backend === 'tmux') {
      const tmux = requireTmux('spawn');
      tmuxName = tmuxSessionName(spawnOptions.provider ?? 'agent', runId);
      file = tmux.config.bin;
      ptyArgs = buildTmuxNewSessionArgs(
        tmux.config,
        tmuxName,
        spawnOptions.command,
        args,
        cols,
        rows,
      );
      backendDetail = {
        kind: 'tmux',
        socket: tmux.config.socket,
        tmuxName,
      };
    }

    const child = pty.spawn(file, ptyArgs, {
      name: 'xterm-color',
      cols,
      rows,
      cwd: spawnOptions.cwd,
      env: buildEnv(spawnOptions.env),
    });

    const meta: TerminalSession = {
      runId,
      pid: child.pid,
      workId: spawnOptions.workId,
      provider: spawnOptions.provider,
      command: spawnOptions.command,
      args,
      cwd: spawnOptions.cwd,
      startedAt: now(),
      status: 'running',
      backend,
      backendDetail,
    };
    const session: Session = {
      meta,
      pty: child,
      buffer: '',
      cols,
      rows,
      tmuxName,
      dataListeners: new Set(),
      exitListeners: new Set(),
    };
    sessions.set(runId, session);
    wireChild(session, child);

    return { ...meta };
  };

  const write: Terminal['write'] = (runId, data) => {
    const session = require_(runId);
    if (
      session.meta.status === 'exited' ||
      session.meta.status === 'orphaned'
    ) {
      throw new Error(`terminal run '${runId}' has exited`);
    }
    session.pty.write(data);
  };

  const resize: Terminal['resize'] = (runId, cols, rows) => {
    const session = require_(runId);
    session.cols = cols;
    session.rows = rows;
    if (session.meta.status !== 'running') return;
    session.pty.resize(cols, rows);
  };

  const kill: Terminal['kill'] = (runId, signal) => {
    const session = require_(runId);
    if (session.meta.status === 'exited' || session.meta.status === 'orphaned')
      return;
    if (session.meta.backend === 'tmux') {
      session.intent = 'kill';
      const tmux = options.tmux;
      if (tmux && session.tmuxName) {
        // Really end the session on the server (the agent dies). The attached
        // client, if any, then exits and onExit finalizes with intent 'kill'.
        void tmux.control
          .run(buildTmuxKillSessionArgs(tmux.config, session.tmuxName))
          .catch(() => {});
      }
      if (session.meta.status === 'detached') {
        // No attached client, so no pty onExit will fire; finalize now.
        finalizeExit(session, 0, undefined);
        return;
      }
      // Attached: signal the client too so it tears down promptly.
      try {
        session.pty.kill(signal);
      } catch {
        /* client may already be gone */
      }
      return;
    }
    session.pty.kill(signal);
  };

  const detach: Terminal['detach'] = (runId) => {
    const session = require_(runId);
    if (session.meta.backend !== 'tmux')
      throw new Error(`terminal run '${runId}' has no detachable backend`);
    if (session.meta.status !== 'running') return;
    // Kill the attach client (SIGHUP by default): the tmux client detaches and
    // the session keeps running on the server. onExit sees intent 'detach' and
    // marks the session detached without firing exit listeners.
    session.intent = 'detach';
    session.pty.kill();
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
    if (
      session.meta.status === 'exited' ||
      session.meta.status === 'orphaned'
    ) {
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

  const discover: Terminal['discover'] = async () => {
    const tmux = requireTmux('discover');
    const res = await tmux.control.run(buildTmuxListArgs(tmux.config));
    if (res.code !== 0) {
      // No server / empty socket: the server did not answer, so we cannot
      // conclude anything about known sessions (F6 "unknown"). Leave statuses
      // untouched and report nothing live.
      return [];
    }
    const liveNames = res.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('kf_'));
    const liveSet = new Set(liveNames);

    // Reconcile known tmux sessions against the live set. Only runs here, where
    // the server actually answered.
    const ownedByName = new Map<string, Session>();
    for (const session of sessions.values()) {
      if (session.meta.backend !== 'tmux' || !session.tmuxName) continue;
      ownedByName.set(session.tmuxName, session);
      // A 'running' session has a live attached pty client, so its tmux session
      // is guaranteed to exist; a racing list snapshot taken while the client is
      // still attaching would not list it yet, and must not orphan it. Only
      // client-gone sessions ('detached'/'orphaned') need liveSet reconciliation.
      if (session.meta.status === 'exited' || session.meta.status === 'running')
        continue;
      if (liveSet.has(session.tmuxName)) {
        // Still on the server. If we'd marked it orphaned on a bad probe, it is
        // actually just detached (reattachable). A 'running' stays 'running'.
        if (session.meta.status === 'orphaned')
          session.meta.status = 'detached';
      } else {
        // Server answered and our name is absent → truly gone, and we did not
        // command it → orphaned.
        session.meta.status = 'orphaned';
        session.meta.endedAt = session.meta.endedAt ?? now();
      }
    }

    return liveNames.map((tmuxName) => {
      const owned = ownedByName.get(tmuxName);
      return {
        tmuxName,
        owned: !!owned,
        attached: owned?.meta.status === 'running',
        runId: owned?.meta.runId,
        provider: owned?.meta.provider,
      };
    });
  };

  const reattach: Terminal['reattach'] = async (runId) => {
    const session = require_(runId);
    const tmux = requireTmux('reattach');
    if (session.meta.backend !== 'tmux' || !session.tmuxName)
      throw new Error(`terminal run '${runId}' is not a tmux session`);
    if (session.meta.status === 'running') return { ...session.meta };
    // Guard: never let attach-or-create silently recreate a gone session (which
    // would re-run the agent command). Only reattach one that still exists.
    const has = await tmux.control.run(
      buildTmuxHasSessionArgs(tmux.config, session.tmuxName),
    );
    if (has.code !== 0) {
      session.meta.status = 'orphaned';
      session.meta.endedAt = session.meta.endedAt ?? now();
      throw new Error(
        `tmux session '${session.tmuxName}' is gone; cannot reattach`,
      );
    }
    const child = pty.spawn(
      tmux.config.bin,
      buildTmuxNewSessionArgs(
        tmux.config,
        session.tmuxName,
        session.meta.command,
        session.meta.args,
        session.cols,
        session.rows,
      ),
      {
        name: 'xterm-color',
        cols: session.cols,
        rows: session.rows,
        cwd: session.meta.cwd,
        env: buildEnv(),
      },
    );
    session.pty = child;
    session.meta.pid = child.pid;
    session.meta.status = 'running';
    session.meta.exitCode = undefined;
    session.meta.exitSignal = undefined;
    session.meta.endedAt = undefined;
    session.intent = undefined;
    wireChild(session, child);
    return { ...session.meta };
  };

  const adopt: Terminal['adopt'] = async (spec) => {
    const tmux = requireTmux('adopt');
    // Already known this run: defer to the normal paths.
    const existing = sessions.get(spec.runId);
    if (existing) {
      if (existing.meta.status === 'running') return { ...existing.meta };
      return reattach(spec.runId);
    }
    const provider = spec.provider ?? 'agent';
    const tmuxName = tmuxSessionName(provider, spec.runId);
    const cols = spec.cols ?? 80;
    const rows = spec.rows ?? 24;
    const command = spec.command ?? '';
    const args = spec.args ?? [];
    const backendDetail: TerminalBackendDetail = {
      kind: 'tmux',
      socket: tmux.config.socket,
      tmuxName,
    };
    const has = await tmux.control.run(
      buildTmuxHasSessionArgs(tmux.config, tmuxName),
    );
    if (has.code !== 0) {
      // Gone: report it as orphaned but do NOT register it, so attach-or-create
      // never recreates and re-runs the command, and the caller can drop it.
      return {
        runId: spec.runId,
        pid: -1,
        provider,
        command,
        args,
        cwd: spec.cwd,
        startedAt: now(),
        status: 'orphaned',
        backend: 'tmux',
        backendDetail,
      };
    }
    // Alive: register the run and attach a fresh client (command ignored on an
    // existing session).
    const child = pty.spawn(
      tmux.config.bin,
      buildTmuxNewSessionArgs(tmux.config, tmuxName, command, args, cols, rows),
      {
        name: 'xterm-color',
        cols,
        rows,
        cwd: spec.cwd,
        env: buildEnv(),
      },
    );
    const meta: TerminalSession = {
      runId: spec.runId,
      pid: child.pid,
      provider,
      command,
      args,
      cwd: spec.cwd,
      startedAt: now(),
      status: 'running',
      backend: 'tmux',
      backendDetail,
    };
    const session: Session = {
      meta,
      pty: child,
      buffer: '',
      cols,
      rows,
      tmuxName,
      dataListeners: new Set(),
      exitListeners: new Set(),
    };
    sessions.set(spec.runId, session);
    wireChild(session, child);
    return { ...meta };
  };

  const list: Terminal['list'] = () =>
    Array.from(sessions.values()).map((s) => ({ ...s.meta }));

  const get: Terminal['get'] = (runId) => {
    const session = sessions.get(runId);
    return session ? { ...session.meta } : undefined;
  };

  return {
    spawn,
    write,
    resize,
    kill,
    detach,
    onData,
    onExit,
    discover,
    reattach,
    adopt,
    list,
    get,
  };
}
