// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cacheAppliedArgs,
  cmdCommand,
  lifecycleEnvironment,
  runShifu,
} from './run-shifu-lifecycle.mjs';

test('copies the lifecycle environment without mutating the caller', () => {
  const input = { PATH: '/tools' };
  const env = lifecycleEnvironment(input, 'check');
  assert.deepEqual(env, input);
  assert.notEqual(env, input);
  assert.equal(env.KF_UPGRADE_QUALIFICATION_REF, undefined);
});

test('adds retained upgrade evidence only to dist', () => {
  const env = lifecycleEnvironment({ PATH: '/tools' }, 'dist');
  assert.match(env.KF_UPGRADE_QUALIFICATION_REF, /^buildchain-retained:/);
  assert.match(env.KF_RUNTIME_ARTIFACT_SIGNATURE, /#runtime$/);
  assert.match(env.KF_DESKTOP_ARTIFACT_SIGNATURE, /#desktop$/);
  assert.match(env.KF_CLI_ARTIFACT_SIGNATURE, /#cli$/);
});

test('preserves release evidence supplied by the build environment', () => {
  const env = lifecycleEnvironment(
    { KF_UPGRADE_QUALIFICATION_REF: 'retained:external' },
    'dist',
  );
  assert.equal(env.KF_UPGRADE_QUALIFICATION_REF, 'retained:external');
});

test('wraps a lifecycle task in cache apply without a shell command', () => {
  assert.deepEqual(
    cacheAppliedArgs(['verify', '--fuzz'], {
      node: '/node path/node',
      script: '/repo path/run-shifu-lifecycle.mjs',
    }),
    [
      'cache',
      'apply',
      '--',
      '/node path/node',
      '/repo path/run-shifu-lifecycle.mjs',
      'direct',
      'verify',
      '--fuzz',
    ],
  );
});

test('runs the Unix shim without a shell', () => {
  const status = runShifu(['--help'], {
    platform: process.platform,
    env: process.env,
    stdio: 'ignore',
  });
  assert.equal(status, 0);
});

test('quotes a Windows shim payload and rejects expansion syntax', () => {
  assert.equal(
    cmdCommand('C:\\repo path\\shifu.cmd', ['install', '--frozen-lockfile']),
    '"C:\\repo path\\shifu.cmd" "install" "--frozen-lockfile"',
  );
  assert.throws(
    () => cmdCommand('C:\\repo\\shifu.cmd', ['task%PATH%']),
    /unsafe cmd syntax/,
  );
});
