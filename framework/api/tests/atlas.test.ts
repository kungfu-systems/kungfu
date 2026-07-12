import assert from 'node:assert/strict';
import test from 'node:test';

import { openAtlas } from '../src/capability/atlas.ts';

test('Atlas projections reserve a bounded large-output buffer', () => {
  let observedMaxBuffer = 0;
  const atlas = openAtlas({
    runtimeDir: '/tmp/kungfu-runtime',
    bin: 'kungfu',
    execFileSync: (_file, args, options) => {
      observedMaxBuffer = options.maxBuffer ?? 0;
      assert.deepEqual(args, ['atlas', 'show', 'missions', '--json']);
      return '[]';
    },
  });

  assert.deepEqual(atlas.missions(), []);
  assert.equal(observedMaxBuffer, 64 * 1024 * 1024);
});

test('Atlas dashboard uses the asynchronous transport and caches one atomic snapshot', async () => {
  let release: ((value: string) => void) | undefined;
  let observedMaxBuffer = 0;
  const atlas = openAtlas({
    runtimeDir: '/tmp/kungfu-runtime',
    bin: 'kungfu',
    execFileSync: () => {
      throw new Error('dashboard must not use the synchronous transport');
    },
    execFile: async (_file, args, options) => {
      assert.deepEqual(args, ['atlas', 'show', 'dashboard', '--json']);
      observedMaxBuffer = options.maxBuffer ?? 0;
      return await new Promise<string>((resolve) => {
        release = resolve;
      });
    },
  });

  const pending = atlas.dashboard();
  assert.equal(atlas.currentDashboard(), null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(release, 'async transport yielded to the event loop');
  release(
    JSON.stringify({
      schema: 'kungfu.mission-control.dashboard-snapshot/v1',
      cut: { kind: 'system_time', system_time: '42' },
      freshness: { status: 'fresh', basis: 'request-cut' },
      import_info: null,
      missions: [{ mission_id: 'mission-a' }],
      goals: [{ goal_id: 'goal-a', mission_id: 'mission-a' }],
    }),
  );
  const snapshot = await pending;

  assert.equal(snapshot.cut.system_time, '42');
  assert.equal(atlas.currentDashboard(), snapshot);
  assert.equal(observedMaxBuffer, 64 * 1024 * 1024);
});
