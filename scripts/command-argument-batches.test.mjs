// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import { commandArgumentBatches } from './command-argument-batches.mjs';

test('command arguments are split below the Windows shell budget', () => {
  const args = ['alpha.js', 'beta-long.js', 'gamma.json', 'delta.css'];
  const batches = commandArgumentBatches(args, 22);

  assert.deepEqual(batches, [
    ['alpha.js', 'beta-long.js'],
    ['gamma.json', 'delta.css'],
  ]);
  assert.deepEqual(batches.flat(), args);
});

test('an oversized single argument remains in its own batch', () => {
  assert.deepEqual(commandArgumentBatches(['long-path.json', 'ok.js'], 5), [
    ['long-path.json'],
    ['ok.js'],
  ]);
});

test('an unlimited budget keeps one invocation', () => {
  assert.deepEqual(
    commandArgumentBatches(['a.js', 'b.js'], Number.POSITIVE_INFINITY),
    [['a.js', 'b.js']],
  );
});
