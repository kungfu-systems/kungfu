// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { cliLauncherContent } from './cli-launcher.mjs';

test('CLI launchers defer install ownership to the colocated product manifest', () => {
  const posix = cliLauncherContent('linux');
  assert.match(posix, /KUNGFU_INSTALL_SOURCE=archive/);
  assert.match(posix, /KUNGFU_DIR="\$here\/runtime"/);
  assert.match(posix, /KUNGFU_PRODUCT_MANIFEST="\$here\/product\.json"/);
  assert.match(posix, /KF_BUNDLED_EXTENSION_ROOT="\$here\/extensions"/);
  assert.match(posix, /KUNGFU_CLI_BIN="\$here\/kungfu"/);
  assert.match(
    posix,
    /KUNGFU_AGENT_SESSION_EXECUTABLE="\$here\/runtime\/kungfu"/,
  );
  assert.match(posix, /KUNGFU_CONTROLLER_ENTRYPOINT="\$here\/runtime\/kungfu"/);
  assert.match(posix, /while \[ -L "\$target" \]/);
  assert.match(posix, /exec "\$here\/runtime\/kungfu" "\$@"/);
  assert.doesNotMatch(posix, /electron/i);

  const windows = cliLauncherContent('win32');
  assert.match(windows, /KUNGFU_INSTALL_SOURCE=archive/);
  assert.match(windows, /KUNGFU_DIR=%~dp0runtime/);
  assert.match(windows, /%~dp0runtime\\kungfu\.exe/);
  assert.match(windows, /KF_BUNDLED_EXTENSION_ROOT=%~dp0extensions/);
  assert.match(windows, /KUNGFU_CLI_BIN=%~dp0kungfu\.cmd/);
  assert.match(
    windows,
    /KUNGFU_AGENT_SESSION_EXECUTABLE=%~dp0runtime\\kungfu\.exe/,
  );
  assert.match(
    windows,
    /KUNGFU_CONTROLLER_ENTRYPOINT=%~dp0runtime\\kungfu\.exe/,
  );
  assert.match(windows, /set "PYTHONUTF8=1"/);
  assert.match(windows, /set "PYTHONIOENCODING=utf-8"/);
  assert.ok(
    windows.indexOf('set "KUNGFU_CLI_BIN=%~dp0kungfu.cmd"') <
      windows.indexOf('"%~dp0runtime\\kungfu.exe" %*'),
  );
  assert.ok(
    windows.indexOf('set "PYTHONIOENCODING=utf-8"') <
      windows.indexOf('"%~dp0runtime\\kungfu.exe" %*'),
  );
  assert.doesNotMatch(windows, /electron/i);
});

test('desktop companion delegates bytecode cache ownership to the native trunk', () => {
  const launcher = readFileSync(
    fileURLToPath(
      new URL('../../framework/gui/resources/cli/kungfu', import.meta.url),
    ),
    'utf8',
  );
  assert.match(launcher, /export KUNGFU_UPGRADE_MANIFEST=/u);
  assert.match(
    launcher,
    /export KF_BUNDLED_EXTENSION_ROOT="\$here\/\.\.\/extensions"/u,
  );
  assert.match(
    launcher,
    /export KUNGFU_AGENT_SESSION_EXECUTABLE="\$runtime\/kungfu"/u,
  );
  assert.match(
    launcher,
    /export KUNGFU_NATIVE_AGENT_SESSION_ENTRY="\$here\/\.\.\/tui\/native-agent-session\.mjs"/u,
  );
  assert.ok(
    launcher.indexOf('export KUNGFU_UPGRADE_MANIFEST=') <
      launcher.indexOf('exec "$runtime/kungfu" "$@"'),
  );
  assert.doesNotMatch(launcher, /PYTHONDONTWRITEBYTECODE/u);
});
