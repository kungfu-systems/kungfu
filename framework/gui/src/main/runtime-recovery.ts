import { type ChildProcessByStdio, execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';

import type {
  AssignmentRuntimeHostReady,
  AssignmentRuntimeRequest,
  AssignmentRuntimeResponse,
} from '@kungfu-tech/api/capability';

import { ASSIGNMENT_RUNTIME_CALL_CHANNEL } from '../sandbox/channels.ts';

export type RuntimeRecoveryReceipt = {
  schema: 'kungfu.gui.runtime-recovery/v1';
  recoveredAt: string;
  originalRuntimeDir: string;
  backupPath: string;
  reason: string;
};

type RuntimeCommandRunner = (
  file: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => unknown;

/**
 * Recovery is the one GUI flow allowed to stop a runtime: it invokes the
 * shared public CLI before moving the selected workspace's runtime directory.
 * Ordinary lifecycle remains owned by the shared runtime surfaces.
 */
export function stopRuntimeForRecovery(options: {
  kungfuBinary: string;
  argsPrefix?: string[];
  env: NodeJS.ProcessEnv;
  run?: RuntimeCommandRunner;
}): void {
  const run = options.run ?? execFileSync;
  run(
    options.kungfuBinary,
    [...(options.argsPrefix ?? []), 'runtime', 'stop'],
    {
      env: options.env,
      timeout: 15_000,
    },
  );
}

function timestampSegment(now: Date): string {
  return now.toISOString().replaceAll(/[-:.]/gu, '');
}

function availableBackupPath(root: string, segment: string): string {
  const candidate = path.join(root, `runtime-${segment}`);
  if (!existsSync(candidate)) return candidate;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const next = `${candidate}-${suffix}`;
    if (!existsSync(next)) return next;
  }
  throw new Error('could not allocate a unique runtime backup path');
}

export function backupAndResetRuntime(options: {
  dataHome: string;
  runtimeDir: string;
  reason: string;
  now?: Date;
}): RuntimeRecoveryReceipt {
  const dataHome = path.resolve(options.dataHome);
  const runtimeDir = path.resolve(options.runtimeDir);
  const expectedRuntimeDir = path.join(dataHome, 'runtime');
  if (runtimeDir !== expectedRuntimeDir) {
    throw new Error(
      `refusing runtime recovery outside the selected data home: ${runtimeDir}`,
    );
  }
  if (!existsSync(runtimeDir)) {
    throw new Error(`runtime directory does not exist: ${runtimeDir}`);
  }

  const now = options.now ?? new Date();
  const backupRoot = path.join(dataHome, 'backups', 'runtime-recovery');
  mkdirSync(backupRoot, { recursive: true });
  const backupPath = availableBackupPath(backupRoot, timestampSegment(now));
  renameSync(runtimeDir, backupPath);
  try {
    mkdirSync(runtimeDir, { recursive: false });
    const receipt: RuntimeRecoveryReceipt = {
      schema: 'kungfu.gui.runtime-recovery/v1',
      recoveredAt: now.toISOString(),
      originalRuntimeDir: runtimeDir,
      backupPath,
      reason: options.reason,
    };
    writeFileSync(
      path.join(backupPath, 'gui-runtime-recovery.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    return receipt;
  } catch (error) {
    try {
      rmdirSync(runtimeDir);
      renameSync(backupPath, runtimeDir);
    } catch {
      // Preserve the original failure. The backup path remains intact.
    }
    throw error;
  }
}

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

type RuntimeHostState = {
  child: HostChild | null;
  ready: AssignmentRuntimeHostReady | null;
  connecting: Promise<AssignmentRuntimeHostReady> | null;
  resolveReady: ((value: AssignmentRuntimeHostReady) => void) | null;
  rejectReady: ((reason: Error) => void) | null;
  stdout: string;
  stderr: string;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  pending: Map<
    string,
    {
      resolve: (value: AssignmentRuntimeResponse) => void;
      reject: (reason: Error) => void;
    }
  >;
};

function failRuntimeHost(state: RuntimeHostState, reason: Error): void {
  if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
  state.handshakeTimer = null;
  state.rejectReady?.(reason);
  state.resolveReady = null;
  state.rejectReady = null;
  state.connecting = null;
  state.ready = null;
  for (const request of state.pending.values()) request.reject(reason);
  state.pending.clear();
}

function receiveRuntimeHostLine(state: RuntimeHostState, line: string): void {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    failRuntimeHost(
      state,
      new Error('Assignment Runtime host emitted invalid JSON'),
    );
    state.child?.kill('SIGTERM');
    return;
  }
  const host = value as AssignmentRuntimeHostReady | HostError;
  if (host.schema === 'kungfu.gui.assignment-runtime-host/v1') {
    if (host.status === 'error') {
      failRuntimeHost(state, hostError(host));
      state.child?.kill('SIGTERM');
      return;
    }
    if (
      host.protocol !== 'kungfu.assignment-runtime/v1' ||
      host.profile?.id !== 'kungfu.assignment-runtime.local'
    ) {
      failRuntimeHost(
        state,
        new Error('Assignment Runtime host advertised an invalid profile'),
      );
      state.child?.kill('SIGTERM');
      return;
    }
    state.ready = host;
    if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
    state.handshakeTimer = null;
    state.resolveReady?.(host);
    state.resolveReady = null;
    state.rejectReady = null;
    return;
  }
  const response = value as AssignmentRuntimeResponse;
  if (response.schema !== 'kungfu.assignment-runtime.response/v1') {
    failRuntimeHost(
      state,
      new Error('Assignment Runtime host emitted an unknown envelope'),
    );
    state.child?.kill('SIGTERM');
    return;
  }
  const request = state.pending.get(response.requestId);
  if (!request) {
    failRuntimeHost(
      state,
      new Error('Assignment Runtime host emitted an unrelated response'),
    );
    state.child?.kill('SIGTERM');
    return;
  }
  state.pending.delete(response.requestId);
  request.resolve(response);
}

function startRuntimeHost(
  deps: AssignmentRuntimeHostDeps,
  state: RuntimeHostState,
): Promise<AssignmentRuntimeHostReady> {
  if (state.connecting) return state.connecting;
  state.connecting = new Promise<AssignmentRuntimeHostReady>(
    (resolve, reject) => {
      state.resolveReady = resolve;
      state.rejectReady = reject;
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
      state.child = launched;
      state.stdout = '';
      state.stderr = '';
      launched.stdout.on('data', (chunk: Buffer | string) => {
        state.stdout += chunk.toString();
        for (;;) {
          const newline = state.stdout.indexOf('\n');
          if (newline < 0) break;
          const line = state.stdout.slice(0, newline).trim();
          state.stdout = state.stdout.slice(newline + 1);
          if (line) receiveRuntimeHostLine(state, line);
        }
      });
      launched.stderr.on('data', (chunk: Buffer | string) => {
        state.stderr = `${state.stderr}${chunk.toString()}`.slice(-8192);
      });
      launched.on('error', (error: Error) => failRuntimeHost(state, error));
      launched.on(
        'exit',
        (code: number | null, signal: NodeJS.Signals | null) => {
          if (state.child !== launched) return;
          state.child = null;
          failRuntimeHost(
            state,
            new Error(
              state.stderr.trim() ||
                `Assignment Runtime host exited ${code ?? signal ?? 'unknown'}`,
            ),
          );
        },
      );
      state.handshakeTimer = setTimeout(() => {
        const error = new Error(
          'Assignment Runtime host did not establish writer readiness in time',
        ) as Error & { code?: string };
        error.code = 'assignment-runtime-host-startup-timeout';
        failRuntimeHost(state, error);
        launched.kill('SIGTERM');
      }, deps.handshakeTimeoutMs ?? 30_000);
    },
  );
  return state.connecting;
}

export function createAssignmentRuntimeHost(deps: AssignmentRuntimeHostDeps) {
  const state: RuntimeHostState = {
    child: null,
    ready: null,
    connecting: null,
    resolveReady: null,
    rejectReady: null,
    stdout: '',
    stderr: '',
    handshakeTimer: null,
    pending: new Map(),
  };

  return {
    connect: async () => state.ready ?? (await startRuntimeHost(deps, state)),
    invoke: async (request: AssignmentRuntimeRequest) => {
      await (state.ready
        ? Promise.resolve(state.ready)
        : startRuntimeHost(deps, state));
      if (!state.child || !state.ready) {
        throw new Error('Assignment Runtime host is unavailable');
      }
      if (state.pending.has(request.requestId)) {
        throw new Error(
          'Assignment Runtime request identity is already pending',
        );
      }
      return await new Promise<AssignmentRuntimeResponse>((resolve, reject) => {
        state.pending.set(request.requestId, { resolve, reject });
        state.child?.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (!error) return;
          state.pending.delete(request.requestId);
          reject(error);
        });
      });
    },
    dispose() {
      const active = state.child;
      state.child = null;
      failRuntimeHost(state, new Error('Assignment Runtime host was disposed'));
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
