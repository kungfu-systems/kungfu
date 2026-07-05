// The Windows AppContainer launch orchestration (ADR-0014): the host-side glue
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
// kungfu-guest holds no binding itself — the same injection discipline ADR-0011
// applies to capabilities. The relay never touches stdout/stdin content here; it
// just gets a GuestChild whose streams happen to be named pipes.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import type { Server, Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AppContainerSpec } from './sandbox-launcher.js';
import type { GuestChild, WindowsSandboxSpawn } from './kungfu-guest.js';

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
// connects (the child's std handle is that client end).
function serveNamedPipe(pipePath: string): {
  path: string;
  connected: Promise<Socket>;
  close: () => void;
} {
  let server: Server | undefined;
  const connected = new Promise<Socket>((resolve, reject) => {
    server = net.createServer((socket) => resolve(socket));
    server.on('error', reject);
    server.listen(pipePath);
  });
  return {
    path: pipePath,
    connected,
    close: () => server?.close(),
  };
}

// Build the WindowsSandboxSpawn from an injected libkungfu binding. Host usage:
//   launchSandboxedGuest({ ..., windowsSpawn: createLibkungfuWindowsSpawn(binding) })
export function createLibkungfuWindowsSpawn(
  binding: LibkungfuWindowsBinding,
): WindowsSandboxSpawn {
  return async (command, args, spec: AppContainerSpec, options) => {
    const stdinServer = serveNamedPipe(uniquePipe('in'));
    const stdoutServer = serveNamedPipe(uniquePipe('out'));

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

    const proc = binding.spawnAppContainer({
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
    // connections. host WRITES to stdin, READS child stdout. If the guest exits
    // BEFORE connecting its pipes (a startup failure — e.g. the runtime cannot
    // initialize under the AppContainer), the connected promises would hang
    // forever. Race them against the exit so a failed launch surfaces as an error
    // carrying the exit code instead of a deadlock.
    const [stdin, stdout] = (await Promise.race([
      Promise.all([stdinServer.connected, stdoutServer.connected]),
      exited.then((code) => {
        throw new Error(
          `sandboxed guest exited before connecting its relay pipes (exit code ${code})`,
        );
      }),
    ])) as [Socket, Socket];

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
  };
}
