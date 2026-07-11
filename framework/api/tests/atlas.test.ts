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
