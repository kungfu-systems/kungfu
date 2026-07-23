// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  platformCommand,
  platformCommandOptions,
  prependEnvironmentPath,
} from './platform-command.mjs';

test('resolves package-manager shims on Windows only', () => {
  assert.equal(platformCommand('npm', 'win32'), 'npm.cmd');
  assert.equal(platformCommand('npx', 'win32'), 'npx.cmd');
  assert.equal(platformCommand('pnpm', 'win32'), 'pnpm.cmd');
  assert.equal(platformCommand('cargo', 'win32'), 'cargo');
  assert.equal(platformCommand('npm', 'linux'), 'npm');
  assert.deepEqual(platformCommandOptions('npm', 'win32'), { shell: true });
  assert.deepEqual(platformCommandOptions('cargo', 'win32'), { shell: false });
  assert.deepEqual(platformCommandOptions('npm', 'linux'), { shell: false });
});

test('prepends Windows Path without creating a case-variant duplicate', () => {
  const environment = prependEnvironmentPath(
    { Path: 'C:\\Rust\\bin;C:\\Windows', HOME: 'C:\\Users\\runner' },
    'D:\\native',
    'win32',
  );
  assert.equal(environment.Path, 'D:\\native;C:\\Rust\\bin;C:\\Windows');
  assert.equal('PATH' in environment, false);
});
