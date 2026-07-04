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
import * as net from 'node:net';
import type { Server, Socket } from 'node:net';

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
    // "KEY=VALUE" pairs
    env: readonly string[];
  }) => AppContainerProcess;
};

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
      env: Object.entries(options.env)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`),
    });

    // native opened the pipes as the child's stdio; the servers accept those
    // connections. host WRITES to stdin, READS child stdout.
    const [stdin, stdout] = await Promise.all([
      stdinServer.connected,
      stdoutServer.connected,
    ]);

    const exitListeners = new Set<(code: number | null) => void>();
    proc
      .wait()
      .then((code) => {
        for (const cb of exitListeners) cb(code);
      })
      .catch(() => {
        for (const cb of exitListeners) cb(null);
      })
      .finally(() => {
        stdinServer.close();
        stdoutServer.close();
      });

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
