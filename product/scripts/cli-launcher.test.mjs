// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cliLauncherContent } from './cli-launcher.mjs';

test('CLI launchers defer install ownership to the colocated product manifest', () => {
  const posix = cliLauncherContent('linux');
  assert.match(posix, /KUNGFU_PRODUCT_MANIFEST="\$here\/product\.json"/);
  assert.match(posix, /while \[ -L "\$target" \]/);
  assert.match(posix, /exec "\$here\/runtime\/kungfu" "\$@"/);
  assert.doesNotMatch(posix, /KUNGFU_INSTALL_SOURCE/);
  assert.doesNotMatch(posix, /electron/i);

  const windows = cliLauncherContent('win32');
  assert.match(windows, /%~dp0runtime\\kungfu\.exe/);
  assert.doesNotMatch(windows, /KUNGFU_INSTALL_SOURCE/);
  assert.doesNotMatch(windows, /electron/i);
});
