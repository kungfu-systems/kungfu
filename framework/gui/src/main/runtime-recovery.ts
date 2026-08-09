import { execFileSync, type ChildProcessByStdio } from 'node:child_process';
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
