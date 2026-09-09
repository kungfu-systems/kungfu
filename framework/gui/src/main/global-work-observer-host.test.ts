import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
  GLOBAL_WORK_OBSERVER_EVENT_CHANNEL,
  GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL,
  GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL,
} from '../sandbox/channels.ts';
import {
  bindElectronGlobalWorkObserver,
  createGlobalWorkObserverHost,
} from './global-work-observer-host.ts';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (signal: string) => boolean;
    killedWith: string;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killedWith = '';
  child.kill = (signal: string) => {
    child.killedWith = signal;
    return true;
  };
  return child;
}

test('main observer owns one durable child and pushes incremental snapshots', () => {
  const child = fakeChild();
  let seenArgs: string[] = [];
  let seenEnv: NodeJS.ProcessEnv = {};
  let spawnCount = 0;
  const received: unknown[] = [];
  const host = createGlobalWorkObserverHost({
    bin: '/kungfu',
    env: {
      KUNGFU_TEST_ENV: 'kept',
      PYTHONDONTWRITEBYTECODE: '0',
    },
    statePath: '/config/gui/global-work-observer.json',
    spawn: (_file, args, options) => {
      spawnCount += 1;
      seenArgs = args;
      seenEnv = options.env;
      return child as never;
    },
    restart: () => ({}) as NodeJS.Timeout,
    cancelRestart: () => {},
  });

  host.subscribe('renderer-1', (event) => received.push(event));
  assert.deepEqual(seenArgs, [
    'workspace',
    'work',
    '--scope',
    'all',
    '--max-workers',
    '8',
    '--include-settled',
    '--observe',
    '--observer-state',
    '/config/gui/global-work-observer.json',
    '--json',
  ]);
  assert.equal(seenEnv.KUNGFU_TEST_ENV, 'kept');
  assert.equal(seenEnv.PYTHONDONTWRITEBYTECODE, '0');
  child.stdout.emit(
    'data',
    `${JSON.stringify({
      schema: 'kungfu.gui.global-work-observer-event/v1',
      kind: 'snapshot',
      mode: 'incremental',
      observed_at: '2026-07-25T00:00:00Z',
      latency_ms: 123,
      changed_workspace_ids: ['project:a'],
      snapshot: { schema: 'kungfu.gui.global-work-snapshot/v1' },
    })}\n`,
  );
  assert.equal(received.length, 1);
  assert.equal((received[0] as { mode: string }).mode, 'incremental');
  child.stdout.emit(
    'data',
    `${JSON.stringify({
      schema: 'kungfu.gui.global-work-observer-event/v1',
      kind: 'snapshot',
      mode: 'incremental',
      observed_at: '2026-07-25T00:00:01Z',
      latency_ms: 120,
      changed_workspace_ids: ['project:a'],
      snapshot: { schema: 'kungfu.gui.global-work-snapshot/v1' },
    })}\n`,
  );
  assert.equal(received.length, 1);

  host.unsubscribe('renderer-1');
  assert.equal(child.killedWith, '');
  host.subscribe('renderer-1', () => {});
  assert.equal(spawnCount, 1);
  host.unsubscribe('renderer-1');
  host.dispose();
  assert.equal(child.killedWith, 'SIGTERM');
});

test('late renderer immediately receives the retained snapshot', () => {
  const child = fakeChild();
  const host = createGlobalWorkObserverHost({
    bin: '/kungfu',
    env: {},
    statePath: '/state',
    spawn: () => child as never,
    restart: () => ({}) as NodeJS.Timeout,
    cancelRestart: () => {},
  });
  host.subscribe('first', () => {});
  child.stdout.emit(
    'data',
    `${JSON.stringify({
      schema: 'kungfu.gui.global-work-observer-event/v1',
      kind: 'snapshot',
      mode: 'resume',
      observed_at: 't',
      latency_ms: 0,
      changed_workspace_ids: [],
      snapshot: {},
    })}\n`,
  );
  const received: unknown[] = [];
  host.subscribe('second', (event) => received.push(event));
  assert.equal(received.length, 1);
  host.dispose();
});

test('first renderer receives the last verified observer cache before a live scan', () => {
  const child = fakeChild();
  const host = createGlobalWorkObserverHost({
    bin: '/kungfu',
    env: {},
    statePath: '/state',
    readState: () =>
      JSON.stringify({
        schema: 'kungfu.gui.global-work-observer/v2',
        query: {
          schema: 'kungfu.workspace-federation.query/v1',
          observed_at: '2026-07-27T14:29:26Z',
          aggregate: { state: 'partial' },
          components: Array.from({ length: 20_000 }, (_, index) => ({
            workspace: { workspace_id: `project:${index}` },
            diagnostics: 'x'.repeat(128),
          })),
          global_work: {
            projection_root: 'sha256:projection',
            visible_work: [
              {
                canonical_root: 'sha256:initiative',
                object_kind: 'initiative',
              },
              {
                canonical_root: 'sha256:assignment',
                object_kind: 'assignment',
              },
            ],
          },
        },
      }),
    spawn: () => child as never,
    restart: () => ({}) as NodeJS.Timeout,
    cancelRestart: () => {},
  });
  const received: unknown[] = [];
  host.subscribe('renderer', (event) => received.push(event));
  assert.equal(received.length, 1);
  assert.equal((received[0] as { mode: string }).mode, 'resume');
  assert.equal(
    (received[0] as { snapshot: { schema: string } }).snapshot.schema,
    'kungfu.gui.global-work-snapshot/v1',
  );
  assert.equal(
    'components' in
      (received[0] as { snapshot: Record<string, unknown> }).snapshot,
    false,
  );
  assert.equal(
    (
      received[0] as {
        snapshot: { global_work: { visible_work: unknown[] } };
      }
    ).snapshot.global_work.visible_work.length,
    2,
  );
  host.dispose();
});

test('one renderer keeps observer delivery until its last listener unsubscribes', () => {
  const child = fakeChild();
  const host = createGlobalWorkObserverHost({
    bin: '/kungfu',
    env: {},
    statePath: '/state',
    spawn: () => child as never,
    restart: () => ({}) as NodeJS.Timeout,
    cancelRestart: () => {},
  });
  const handlers = new Map<
    string,
    (event: {
      sender: {
        id: number;
        send: (channel: string, payload: unknown) => void;
        isDestroyed: () => boolean;
        once: (event: 'destroyed', listener: () => void) => void;
      };
    }) => unknown
  >();
  const rendererListeners = new Set<(payload: unknown) => void>();
  const sender = {
    id: 7,
    send: (channel: string, payload: unknown) => {
      assert.equal(channel, GLOBAL_WORK_OBSERVER_EVENT_CHANNEL);
      for (const listener of rendererListeners) listener(payload);
    },
    isDestroyed: () => false,
    once: () => {},
  };
  const binding = bindElectronGlobalWorkObserver(
    {
      handle: (channel, listener) => handlers.set(channel, listener),
      removeHandler: (channel) => handlers.delete(channel),
    },
    host,
  );
  const first: unknown[] = [];
  const second: unknown[] = [];
  const firstListener = (payload: unknown) => first.push(payload);
  const secondListener = (payload: unknown) => second.push(payload);
  rendererListeners.add(firstListener);
  handlers.get(GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL)?.({ sender });
  rendererListeners.add(secondListener);
  handlers.get(GLOBAL_WORK_OBSERVER_SUBSCRIBE_CHANNEL)?.({ sender });

  const emitSnapshot = (revision: string) =>
    child.stdout.emit(
      'data',
      `${JSON.stringify({
        schema: 'kungfu.gui.global-work-observer-event/v1',
        kind: 'snapshot',
        mode: 'incremental',
        observed_at: revision,
        latency_ms: 1,
        changed_workspace_ids: ['project:a'],
        snapshot: {
          aggregate: { revision },
          global_work: { projection_root: revision },
        },
      })}\n`,
    );
  emitSnapshot('one');
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);

  rendererListeners.delete(firstListener);
  handlers.get(GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL)?.({ sender });
  emitSnapshot('two');
  assert.equal(first.length, 1);
  assert.equal(second.length, 2);

  rendererListeners.delete(secondListener);
  handlers.get(GLOBAL_WORK_OBSERVER_UNSUBSCRIBE_CHANNEL)?.({ sender });
  emitSnapshot('three');
  assert.equal(second.length, 2);
  binding.dispose();
});
