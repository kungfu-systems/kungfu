// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cliLauncherContent } from './cli-launcher.mjs';

test('CLI launchers freeze archive ownership without embedding Electron', () => {
  const posix = cliLauncherContent('linux');
  assert.match(posix, /KUNGFU_INSTALL_SOURCE=archive/);
  assert.match(posix, /KUNGFU_PRODUCT_MANIFEST="\$here\/product\.json"/);
  assert.match(posix, /exec "\$here\/kungfu\/kungfu" "\$@"/);
  assert.doesNotMatch(posix, /electron/i);

  const windows = cliLauncherContent('win32');
  assert.match(windows, /KUNGFU_INSTALL_SOURCE=archive/);
  assert.match(windows, /%~dp0kungfu\\kungfu\.exe/);
  assert.doesNotMatch(windows, /electron/i);
});
