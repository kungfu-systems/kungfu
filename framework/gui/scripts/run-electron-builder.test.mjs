// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeBuilderArgs } from './run-electron-builder.mjs';

test('electron-builder defaults to non-publishing mode in CI', () => {
  assert.deepEqual(normalizeBuilderArgs(['--dir'], '/tmp/electron'), [
    '--dir',
    '--publish=never',
    '--config.electronDist=/tmp/electron',
  ]);
});

test('electron-builder preserves an explicit publish mode', () => {
  assert.deepEqual(
    normalizeBuilderArgs(['--publish=always'], '/tmp/electron'),
    ['--publish=always', '--config.electronDist=/tmp/electron'],
  );
});
