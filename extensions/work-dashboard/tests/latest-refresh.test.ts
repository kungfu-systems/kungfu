import assert from 'node:assert/strict';
import test from 'node:test';

import { createLatestRefresh } from '../src/view/latest-refresh.ts';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('coalesces overlap and only applies the latest requested snapshot', async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  const loads = [first.promise, second.promise];
  const applied: string[] = [];
  let active = 0;
  let maxActive = 0;
  let loadCount = 0;
  const idle = deferred<void>();

  const refresh = createLatestRefresh({
    load: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const value = await loads[loadCount++];
      active -= 1;
      return value;
    },
    apply: (value) => applied.push(value),
    fail: (error) => assert.fail(error),
    idle: () => idle.resolve(),
  });

  refresh.request();
  refresh.request();
  refresh.request();
  first.resolve('obsolete');
  await first.promise;
  await new Promise((resolve) => setImmediate(resolve));
  second.resolve('latest');
  await idle.promise;

  assert.equal(loadCount, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(applied, ['latest']);
});

test('dispose drops a late result', async () => {
  const pending = deferred<string>();
  const applied: string[] = [];
  const refresh = createLatestRefresh({
    load: () => pending.promise,
    apply: (value) => applied.push(value),
    fail: (error) => assert.fail(error),
  });

  refresh.request();
  refresh.dispose();
  pending.resolve('late');
  await pending.promise;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(applied, []);
});
