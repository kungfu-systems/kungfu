import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type {
  AssignmentRuntimeHostReady,
  AssignmentRuntimeRequest,
  AssignmentRuntimeResponse,
} from '@kungfu-tech/api/capability';

import { ASSIGNMENT_RUNTIME_CALL_CHANNEL } from '../sandbox/channels.ts';

type HostChild = ChildProcessByStdio<Writable, Readable, Readable>;

type HostError = {
  schema: 'kungfu.gui.assignment-runtime-host/v1';
  status: 'error';
  error: { code: string; message: string; retryable: boolean };
};

export type AssignmentRuntimeHostDeps = {
  bin: string;
  env: NodeJS.ProcessEnv;
  argsPrefix?: string[];
  handshakeTimeoutMs?: number;
  workspaceRoot?: string;
  spawn: (
    file: string,
    args: string[],
    options: {
      env: NodeJS.ProcessEnv;
      stdio: ['pipe', 'pipe', 'pipe'];
    },
  ) => HostChild;
};

function hostError(value: HostError): Error {
  const error = new Error(value.error.message) as Error & { code?: string };
  error.code = value.error.code;
  return error;
}

export function createAssignmentRuntimeHost(deps: AssignmentRuntimeHostDeps) {
  let child: HostChild | null = null;
  let ready: AssignmentRuntimeHostReady | null = null;
  let connecting: Promise<AssignmentRuntimeHostReady> | null = null;
  let resolveReady: ((value: AssignmentRuntimeHostReady) => void) | null = null;
  let rejectReady: ((reason: Error) => void) | null = null;
  let stdout = '';
  let stderr = '';
  let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  const pending = new Map<
    string,
    {
      resolve: (value: AssignmentRuntimeResponse) => void;
      reject: (reason: Error) => void;
    }
  >();

  const fail = (reason: Error) => {
    if (handshakeTimer) clearTimeout(handshakeTimer);
    handshakeTimer = null;
    rejectReady?.(reason);
    resolveReady = null;
    rejectReady = null;
    connecting = null;
    ready = null;
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
  };

  const receive = (line: string) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail(new Error('Assignment Runtime host emitted invalid JSON'));
      child?.kill('SIGTERM');
      return;
    }
    const host = value as AssignmentRuntimeHostReady | HostError;
    if (host.schema === 'kungfu.gui.assignment-runtime-host/v1') {
      if (host.status === 'error') {
        fail(hostError(host));
        child?.kill('SIGTERM');
        return;
      }
      if (
        host.protocol !== 'kungfu.assignment-runtime/v1' ||
        host.profile?.id !== 'kungfu.assignment-runtime.local'
      ) {
        fail(
          new Error('Assignment Runtime host advertised an invalid profile'),
        );
        child?.kill('SIGTERM');
        return;
      }
      ready = host;
      if (handshakeTimer) clearTimeout(handshakeTimer);
      handshakeTimer = null;
      resolveReady?.(host);
      resolveReady = null;
      rejectReady = null;
      return;
    }
    const response = value as AssignmentRuntimeResponse;
    if (response.schema !== 'kungfu.assignment-runtime.response/v1') {
      fail(new Error('Assignment Runtime host emitted an unknown envelope'));
      child?.kill('SIGTERM');
      return;
    }
    const request = pending.get(response.requestId);
    if (!request) {
      fail(new Error('Assignment Runtime host emitted an unrelated response'));
      child?.kill('SIGTERM');
      return;
    }
    pending.delete(response.requestId);
    request.resolve(response);
  };

  const start = () => {
    if (connecting) return connecting;
    connecting = new Promise<AssignmentRuntimeHostReady>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
      const args = [
        ...(deps.argsPrefix ?? []),
        'work',
        'runtime-host',
        ...(deps.workspaceRoot
          ? ['--workspace', deps.workspaceRoot]
          : ['--home']),
      ];
      const launched = deps.spawn(deps.bin, args, {
        env: { ...deps.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child = launched;
      stdout = '';
      stderr = '';
      launched.stdout.on('data', (chunk: Buffer | string) => {
        stdout += chunk.toString();
        for (;;) {
          const newline = stdout.indexOf('\n');
          if (newline < 0) break;
          const line = stdout.slice(0, newline).trim();
          stdout = stdout.slice(newline + 1);
          if (line) receive(line);
        }
      });
      launched.stderr.on('data', (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-8192);
      });
      launched.on('error', (error: Error) => fail(error));
      launched.on(
        'exit',
        (code: number | null, signal: NodeJS.Signals | null) => {
          if (child !== launched) return;
          child = null;
          fail(
            new Error(
              stderr.trim() ||
                `Assignment Runtime host exited ${code ?? signal ?? 'unknown'}`,
            ),
          );
        },
      );
      handshakeTimer = setTimeout(() => {
        const error = new Error(
          'Assignment Runtime host did not establish writer readiness in time',
        ) as Error & { code?: string };
        error.code = 'assignment-runtime-host-startup-timeout';
        fail(error);
        launched.kill('SIGTERM');
      }, deps.handshakeTimeoutMs ?? 30_000);
    });
    return connecting;
  };

  return {
    connect: async () => ready ?? (await start()),
    invoke: async (request: AssignmentRuntimeRequest) => {
      await (ready ? Promise.resolve(ready) : start());
      if (!child || !ready) {
        throw new Error('Assignment Runtime host is unavailable');
      }
      if (pending.has(request.requestId)) {
        throw new Error(
          'Assignment Runtime request identity is already pending',
        );
      }
      return await new Promise<AssignmentRuntimeResponse>((resolve, reject) => {
        pending.set(request.requestId, { resolve, reject });
        child?.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (!error) return;
          pending.delete(request.requestId);
          reject(error);
        });
      });
    },
    dispose() {
      const active = child;
      child = null;
      fail(new Error('Assignment Runtime host was disposed'));
      active?.kill('SIGTERM');
    },
  };
}

type AssignmentRuntimeIpcMain = {
  handle: (
    channel: string,
    listener: (_event: unknown, payload?: unknown) => unknown,
  ) => void;
  removeHandler: (channel: string) => void;
};

export function bindElectronAssignmentRuntime(
  ipcMain: AssignmentRuntimeIpcMain,
  host: ReturnType<typeof createAssignmentRuntimeHost>,
) {
  ipcMain.handle(ASSIGNMENT_RUNTIME_CALL_CHANNEL, (_event, payload) => {
    const request = payload as
      | { operation: 'connect' }
      | { operation: 'invoke'; request: AssignmentRuntimeRequest };
    if (request?.operation === 'connect') return host.connect();
    if (request?.operation === 'invoke' && request.request) {
      return host.invoke(request.request);
    }
    throw new Error('invalid Assignment Runtime IPC request');
  });
  return {
    dispose() {
      ipcMain.removeHandler(ASSIGNMENT_RUNTIME_CALL_CHANNEL);
      host.dispose();
    },
  };
}
