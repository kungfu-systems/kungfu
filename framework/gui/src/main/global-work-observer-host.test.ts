import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createGlobalWorkObserverHost } from './global-work-observer-host.ts';

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
          global_work: {
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
    (
      received[0] as {
        snapshot: { global_work: { visible_work: unknown[] } };
      }
    ).snapshot.global_work.visible_work.length,
    2,
  );
  host.dispose();
});
