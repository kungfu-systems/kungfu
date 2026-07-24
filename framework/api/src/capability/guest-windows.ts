// The Windows AppContainer launch orchestration (KF-ADR-019f86da-4f90-7789-8b48-620aa694acf9): the host-side glue
// that turns libkungfu's native `spawn_app_container` into the WindowsSandboxSpawn
// kungfu-guest expects. It is deliberately thin — the streaming stays in Node so
// the blind native surface is as small as possible:
//
//   1. Node creates two named-pipe servers (net supports Windows named pipes
//      natively) — one carries the child's stdin, one its stdout.
//   2. The native launcher opens those pipes as inheritable client handles, sets
//      them as the child's std handles, and CreateProcess-es the child INTO the
//      AppContainer (the membrane). Native does only that plus an async exit
//      wait — no stream implementation of its own.
//   3. Node's accepted sockets become the GuestChild's stdout/stdin; the native
//      process object's `wait()` drives the exit event and `kill()` terminates it.
//
// The native binding is INJECTED (createLibkungfuWindowsSpawn(binding)) so
// kungfu-guest holds no binding itself — the same injection discipline KF-ADR-019f86da-4f90-7e5e-ae22-2a8fc24086f1
// applies to capabilities. The relay never touches stdout/stdin content here; it
// just gets a GuestChild whose streams happen to be named pipes.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import type { Server, Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { GuestChild, WindowsSandboxSpawn } from './kungfu-guest.js';
import type { AppContainerSpec } from './sandbox-launcher.js';

// The native process object libkungfu `spawn_app_container` returns. It owns the
// Windows process HANDLE; JS never sees a raw handle.
export type AppContainerProcess = {
  // resolves with the exit code when the child exits (async wait in native)
  wait: () => Promise<number>;
  // TerminateProcess
  kill: () => void;
};

// The subset of the libkungfu binding this needs. The host injects the whole
// binding; only `spawnAppContainer` is used here.
export type LibkungfuWindowsBinding = {
  spawnAppContainer: (spec: {
    command: string;
    args: readonly string[];
    // named-pipe paths the native launcher opens as the child's std handles
    stdinPipe: string;
    stdoutPipe: string;
    // AppContainer membrane (from windowsAppContainerSpec)
    moniker: string;
    displayName: string;
    capabilities: readonly string[];
    allowBroadWrite: boolean;
    allowLoopback: boolean;
    // directories the launcher grants the AppContainer SID read+execute on (plus
    // traverse on their ancestors) so the guest stays readable — AppContainer file
    // access is governed by the container SID's ACE, not the user's. Derived from
    // the interpreter + guest entry paths.
    readPaths: readonly string[];
    // a user-space scratch dir passed to the guest as KFX_WRITE_PROBE. A permissive
    // profile grants the container SID write on it (so the guest's write succeeds);
    // denyWrite leaves it ungranted (so the write is refused).
    writeScratch: string;
    // "KEY=VALUE" pairs
    env: readonly string[];
  }) => AppContainerProcess;
};

// The guest process started but then EXITED before it ever connected its relay
// pipes — a genuine startup failure (e.g. the denyNetwork guest early-exit).
// Retrying with fresh pipes would not change the outcome, so the spawn loop
// surfaces this immediately instead of retrying.
class GuestExitedBeforeConnect extends Error {}

// The guest neither connected its relay pipes nor exited within the handshake
// window — the intermittent named-pipe OVERLAPPED handshake loss that used to
// hang forever. This IS retryable: a fresh pair of pipes usually connects.
class RelayHandshakeTimeout extends Error {}

// The directories the guest must be readable from: the interpreter's own
// directory and the directory of each absolute path passed on its argv (the
// resolver hook, the child bootstrap, the facet entry). Granting the containing
// directory — rather than each file — keeps the guest bundle readable as it
// resolves siblings, and the native launcher adds ancestor traverse. This
// codifies what a basic AppContainer previously needed manual icacls for.
function deriveReadPaths(
  command: string,
  args: readonly string[],
): readonly string[] {
  const dirs = new Set<string>();
  const addFileDir = (p: string) => {
    if (isAbsolute(p) && existsSync(p)) dirs.add(dirname(p));
  };
  addFileDir(command);
  for (const arg of args) {
    let candidate = arg;
    if (candidate.startsWith('file://')) {
      try {
        candidate = fileURLToPath(candidate);
      } catch {
        continue;
      }
    }
    addFileDir(candidate);
  }
  return [...dirs];
}

let pipeSeq = 0;

function uniquePipe(kind: string): string {
  pipeSeq += 1;
  // process-unique, collision-safe within this host; native connects as client
  return `\\\\.\\pipe\\kfx-guest-${process.pid}-${pipeSeq}-${kind}`;
}

// Create a named-pipe server and resolve with the socket the native client
// connects (the child's std handle is that client end). `listening` resolves
// once the pipe instance actually exists — the native launcher opens the pipe
// with CreateFile(OPEN_EXISTING), which has no wait/retry of its own, so the
// host must not spawn until both pipes are listening.
function serveNamedPipe(pipePath: string): {
  path: string;
  listening: Promise<void>;
  connected: Promise<Socket>;
  close: () => void;
} {
  let resolveConnected!: (socket: Socket) => void;
  let rejectConnected!: (err: unknown) => void;
  const connected = new Promise<Socket>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const server: Server = net.createServer((socket) => resolveConnected(socket));
  server.on('error', (err) => rejectConnected(err));
  const listening = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  server.listen(pipePath);
  return {
    path: pipePath,
    listening,
    connected,
    close: () => server.close(),
  };
}

// One spawn attempt: create fresh pipes, wait until they are listening, launch
// the guest, and wait for the relay handshake — bounded by `timeoutMs`. Resolves
// with the wired GuestChild, or throws GuestExitedBeforeConnect / a native error
// / RelayHandshakeTimeout so the caller can decide whether to retry.
async function spawnGuestOnce(
  binding: LibkungfuWindowsBinding,
  command: string,
  args: readonly string[],
  spec: AppContainerSpec,
  options: { env: Record<string, string | undefined> },
  timeoutMs: number,
): Promise<GuestChild> {
  const stdinServer = serveNamedPipe(uniquePipe('in'));
  const stdoutServer = serveNamedPipe(uniquePipe('out'));

  // Both pipe instances must exist BEFORE the native launcher opens them as
  // client handles: CreateFile(OPEN_EXISTING) fails outright if the pipe is not
  // yet created, and `server.listen()` is asynchronous. Waiting here removes the
  // host-listen-vs-native-CreateFile race entirely.
  await Promise.all([stdinServer.listening, stdoutServer.listening]);

  // A per-launch write-probe scratch dir under the home directory — a clean
  // user-space location the AppContainer inherits no write ACE on. permissive
  // grants the container SID write here (via writeScratch); denyWrite does not,
  // so the facet's write is refused. It sits outside the runtime's TEMP (which
  // the native launcher redirects to the AppContainer folder), so it observes
  // only the write knob. Removed when the guest exits.
  pipeSeq += 1;
  const scratch = join(
    homedir(),
    '.kfx-guest-scratch',
    `${process.pid}-${pipeSeq}`,
  );
  mkdirSync(scratch, { recursive: true });
  const cleanupScratch = () => {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {}
  };

  let proc: AppContainerProcess;
  try {
    proc = binding.spawnAppContainer({
      command,
      args,
      stdinPipe: stdinServer.path,
      stdoutPipe: stdoutServer.path,
      moniker: spec.moniker,
      displayName: spec.displayName,
      capabilities: spec.capabilities,
      allowBroadWrite: spec.allowBroadWrite,
      allowLoopback: spec.allowLoopback,
      readPaths: deriveReadPaths(command, args),
      writeScratch: scratch,
      env: Object.entries(options.env)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`),
    });
  } catch (err) {
    // native CreateProcess / CreateFile failed synchronously — no process to
    // wait on. Clean the pipes and scratch here (the exit-wiring below never
    // ran) and let the caller retry.
    stdinServer.close();
    stdoutServer.close();
    cleanupScratch();
    throw err;
  }

  // A single exit wait, shared between the startup guard below and the exit
  // event wiring.
  const exited = proc.wait();
  const exitListeners = new Set<(code: number | null) => void>();
  exited
    .then((code) => {
      for (const cb of exitListeners) cb(code);
    })
    .catch(() => {
      for (const cb of exitListeners) cb(null);
    })
    .finally(() => {
      stdinServer.close();
      stdoutServer.close();
      cleanupScratch();
    });

  // native opened the pipes as the child's stdio; the servers accept those
  // connections. host WRITES to stdin, READS child stdout. Three ways the wait
  // ends: (a) both pipes connect — success; (b) the guest exits BEFORE connecting
  // (a startup failure) — surface the exit code, no retry; (c) neither happens
  // within the handshake window (the intermittent OVERLAPPED handshake loss) —
  // kill the stuck guest and let the caller retry with fresh pipes. The
  // `connectedOk` flag makes the exit branch throw ONLY while the pipes are still
  // pending, so a normal later exit does not reject an already-settled race.
  let connectedOk = false;
  const connections = Promise.all([
    stdinServer.connected,
    stdoutServer.connected,
  ]).then((pair) => {
    connectedOk = true;
    return pair;
  });
  const startupGuard = exited.then((code) => {
    if (!connectedOk) {
      throw new GuestExitedBeforeConnect(
        `sandboxed guest exited before connecting its relay pipes (exit code ${code})`,
      );
    }
    return undefined as never;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new RelayHandshakeTimeout(
          `sandboxed guest did not connect its relay pipes within ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
    // do not let the handshake timer keep the event loop alive on its own
    timer.unref?.();
  });

  let stdin: Socket;
  let stdout: Socket;
  try {
    [stdin, stdout] = (await Promise.race([
      connections,
      startupGuard,
      timeout,
    ])) as [Socket, Socket];
  } catch (err) {
    if (err instanceof RelayHandshakeTimeout) {
      // the guest is up but never connected — kill it so the retry starts from a
      // clean slate. The kill drives `exited`, whose finally closes the servers
      // and removes the scratch dir.
      proc.kill();
    }
    // GuestExitedBeforeConnect: the process already exited, so `exited.finally`
    // handles pipe/scratch cleanup. Native errors are handled above.
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const child: GuestChild = {
    stdout,
    stdin,
    on(event, cb) {
      if (event === 'exit') exitListeners.add(cb);
    },
    once(event, cb) {
      if (event === 'exit' || event === 'close') {
        const wrap = () => {
          exitListeners.delete(wrap as never);
          cb();
        };
        exitListeners.add(wrap as never);
      }
    },
    kill: () => proc.kill(),
  };
  return child;
}

// Build the WindowsSandboxSpawn from an injected libkungfu binding. Host usage:
//   launchSandboxedGuest({ ..., windowsSpawn: createLibkungfuWindowsSpawn(binding) })
export function createLibkungfuWindowsSpawn(
  binding: LibkungfuWindowsBinding,
): WindowsSandboxSpawn {
  return async (command, args, spec: AppContainerSpec, options) => {
    // The relay handshake (host pipe servers ↔ the native CreateFile client ends)
    // is intermittently lost on Windows: the guest starts but never appears on
    // the pipes, so the connection wait would hang forever. Bound each attempt
    // with a timeout and retry the whole spawn with fresh pipes. A guest that
    // EXITS before connecting is a real startup failure (the denyNetwork
    // early-exit) and is surfaced immediately — a fresh pipe would not save it.
    const HANDSHAKE_TIMEOUT_MS = 15_000;
    const MAX_ATTEMPTS = 3;

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        return await spawnGuestOnce(
          binding,
          command,
          args,
          spec,
          options,
          HANDSHAKE_TIMEOUT_MS,
        );
      } catch (err) {
        lastErr = err;
        if (
          err instanceof GuestExitedBeforeConnect ||
          attempt === MAX_ATTEMPTS
        ) {
          throw err;
        }
        // relay handshake timed out or the pipe open raced — retry with fresh pipes
      }
    }
    throw lastErr;
  };
}
