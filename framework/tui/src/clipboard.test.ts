// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { copyTextToClipboard } from './clipboard/index.js';

test('clipboard copy uses the native macOS command without a shell', () => {
  const calls: Array<{ file: string; args: string[]; input: string }> = [];
  const receipt = copyTextToClipboard('/work/project/README.md', {
    platform: 'darwin',
    exec: (file, args, options) => {
      calls.push({ file, args, input: options.input });
    },
  });
  assert.deepEqual(receipt, { ok: true, method: 'pbcopy' });
  assert.deepEqual(calls, [
    {
      file: '/usr/bin/pbcopy',
      args: [],
      input: '/work/project/README.md',
    },
  ]);
});

test('clipboard copy falls through unavailable Linux commands', () => {
  const calls: string[] = [];
  const receipt = copyTextToClipboard('/work/project/src/main.ts', {
    platform: 'linux',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    exec: (file) => {
      calls.push(file);
      if (file !== 'xclip') throw new Error('unavailable');
    },
  });
  assert.equal(receipt.ok, true);
  assert.deepEqual(calls, ['wl-copy', 'xclip']);
});
