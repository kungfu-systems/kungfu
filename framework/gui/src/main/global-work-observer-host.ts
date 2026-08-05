import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import {
  GLOBAL_WORK_OBSERVER_EVENT_CHANNEL,
  GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL,
  GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL,
} from '../sandbox/channels';

export type GlobalWorkObserverEvent =
  | {
      schema: 'kungfu.gui.global-work-observer-event/v1';
      kind: 'snapshot';
      mode: 'resume' | 'incremental' | 'recovery';
      observed_at: string;
      latency_ms: number;
      changed_workspace_ids: string[];
      snapshot: Record<string, unknown>;
    }
  | {
      schema: 'kungfu.gui.global-work-observer-event/v1';
      kind: 'error';
      error: string;
    };

type ObserverChild = ChildProcessByStdio<null, Readable, Readable>;

export type GlobalWorkObserverHostDeps = {
  bin: string;
  env: NodeJS.ProcessEnv;
  argsPrefix?: string[];
  statePath: string;
  readState?: (path: string) => string;
  spawn: (
    file: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; stdio: ['ignore', 'pipe', 'pipe'] },
  ) => ObserverChild;
  restart: (fn: () => void, delayMs: number) => NodeJS.Timeout;
  cancelRestart: (timer: NodeJS.Timeout) => void;
};

function parseObserverEvent(line: string): GlobalWorkObserverEvent | null {
  try {
    const value = JSON.parse(line) as GlobalWorkObserverEvent;
    if (
      value?.schema === 'kungfu.gui.global-work-observer-event/v1' &&
      (value.kind === 'snapshot' || value.kind === 'error')
    ) {
      return value;
    }
  } catch {
    // The child owns a line protocol; partial chunks are buffered by the host.
  }
  return null;
}

function snapshotRevision(event: GlobalWorkObserverEvent): string {
  if (event.kind !== 'snapshot') return '';
  const projection = event.snapshot.global_work as
    | Record<string, unknown>
    | undefined;
  return JSON.stringify({
    projection_root: projection?.projection_root,
    aggregate: event.snapshot.aggregate,
    verification: event.snapshot.verification,
  });
}

function cachedObserverSnapshot(value: string): GlobalWorkObserverEvent | null {
  try {
    const state = JSON.parse(value) as {
      schema?: string;
      query?: Record<string, unknown>;
    };
    const query = state.query;
    const globalWork = query?.global_work as
      | { visible_work?: unknown }
      | undefined;
    if (
      state.schema !== 'kungfu.gui.global-work-observer/v2' ||
      query?.schema !== 'kungfu.workspace-federation.query/v1' ||
      !Array.isArray(globalWork?.visible_work)
    ) {
      return null;
    }
    return {
      schema: 'kungfu.gui.global-work-observer-event/v1',
      kind: 'snapshot',
      mode: 'resume',
      observed_at:
        typeof query.observed_at === 'string' ? query.observed_at : '',
      latency_ms: 0,
      changed_workspace_ids: [],
      snapshot: query,
    };
  } catch {
    return null;
  }
}

export function createGlobalWorkObserverHost(deps: GlobalWorkObserverHostDeps) {
  const subscribers = new Map<
    string,
    (event: GlobalWorkObserverEvent) => void
  >();
  let child: ObserverChild | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let latestSnapshot: GlobalWorkObserverEvent | null = null;
  let latestRevision = '';
  let stopped = false;

  const emit = (event: GlobalWorkObserverEvent) => {
    if (event.kind === 'snapshot') {
      const revision = snapshotRevision(event);
      if (revision && revision === latestRevision) return;
      latestRevision = revision;
      latestSnapshot = event;
    }
    for (const subscriber of subscribers.values()) subscriber(event);
  };

  const start = () => {
    if (stopped || child || subscribers.size === 0) return;
    let stdout = '';
    let stderr = '';
    const launched = deps.spawn(
      deps.bin,
      [
        ...(deps.argsPrefix ?? []),
        'workspace',
        'work',
        '--scope',
        'all',
        '--max-workers',
        '8',
        '--include-settled',
        '--observe',
        '--observer-state',
        deps.statePath,
        '--json',
      ],
      {
        env: { ...deps.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child = launched;
    launched.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) break;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        const event = parseObserverEvent(line);
        if (event) emit(event);
      }
    });
    launched.stderr.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8192);
    });
    launched.on('error', (error: Error) => {
      emit({
        schema: 'kungfu.gui.global-work-observer-event/v1',
        kind: 'error',
        error: error.message,
      });
    });
    launched.on(
      'exit',
      (_code: number | null, signal: NodeJS.Signals | null) => {
        if (child !== launched) return;
        child = null;
        if (stopped || subscribers.size === 0) return;
        emit({
          schema: 'kungfu.gui.global-work-observer-event/v1',
          kind: 'error',
          error:
            stderr.trim() ||
            `global Work observer exited${signal ? ` (${signal})` : ''}`,
        });
        restartTimer = deps.restart(() => {
          restartTimer = null;
          start();
        }, 1000);
      },
    );
  };

  return {
    subscribe(
      clientKey: string,
      subscriber: (event: GlobalWorkObserverEvent) => void,
    ) {
      subscribers.set(clientKey, subscriber);
      if (!latestSnapshot && deps.readState) {
        try {
          const cached = cachedObserverSnapshot(deps.readState(deps.statePath));
          if (cached) {
            latestSnapshot = cached;
            latestRevision = snapshotRevision(cached);
          }
        } catch {
          // A missing or partial cache never blocks the live observer.
        }
      }
      if (latestSnapshot) subscriber(latestSnapshot);
      start();
    },
    unsubscribe(clientKey: string) {
      subscribers.delete(clientKey);
    },
    dispose() {
      stopped = true;
      subscribers.clear();
      if (restartTimer) deps.cancelRestart(restartTimer);
      restartTimer = null;
      child?.kill('SIGTERM');
      child = null;
    },
  };
}

type ObserverIpcEvent = {
  sender: {
    id: number;
    send: (channel: string, payload: unknown) => void;
    isDestroyed?: () => boolean;
    once?: (event: 'destroyed', listener: () => void) => void;
  };
};

type ObserverIpcMain = {
  handle: (
    channel: string,
    listener: (event: ObserverIpcEvent, payload?: unknown) => unknown,
  ) => void;
  removeHandler: (channel: string) => void;
};

export function bindElectronGlobalWorkObserver(
  ipcMain: ObserverIpcMain,
  host: ReturnType<typeof createGlobalWorkObserverHost>,
) {
  const cleanupWired = new Set<number>();
  ipcMain.handle(GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL, (event) => {
    const sender = event.sender;
    const clientKey = String(sender.id);
    if (!cleanupWired.has(sender.id)) {
      cleanupWired.add(sender.id);
      sender.once?.('destroyed', () => {
        host.unsubscribe(clientKey);
        cleanupWired.delete(sender.id);
      });
    }
    host.subscribe(clientKey, (payload) => {
      if (!sender.isDestroyed?.()) {
        sender.send(GLOBAL_WORK_OBSERVER_EVENT_CHANNEL, payload);
      }
    });
    return undefined;
  });
  ipcMain.handle(GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL, (event) => {
    host.unsubscribe(String(event.sender.id));
    return undefined;
  });
  return {
    dispose() {
      host.dispose();
      ipcMain.removeHandler(GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL);
      ipcMain.removeHandler(GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL);
    },
  };
}
