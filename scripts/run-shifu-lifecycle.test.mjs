// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cacheAppliedArgs,
  cacheAppliedCommandArgs,
  cacheAwareArgs,
  cmdCommand,
  lifecycleEnvironment,
  runShifu,
  windowsCmdArgs,
} from './run-shifu-lifecycle.mjs';

test('wraps an arbitrary child command in one cache projection', () => {
  assert.deepEqual(
    cacheAppliedCommandArgs('/node path/node', [
      '/repo path/run-gate-measurement.mjs',
      'gate',
      'run',
    ]),
    [
      'cache',
      'apply',
      '--',
      '/node path/node',
      '/repo path/run-gate-measurement.mjs',
      'gate',
      'run',
    ],
  );
});

test('an active cache projection is reused without acquiring a second partition', () => {
  assert.deepEqual(
    cacheAwareArgs(['pack:spec'], { env: { SHIFU_CACHE_ACTIVE: '1' } }),
    ['pack:spec'],
  );
});

test('an inactive lifecycle enters the cache projection exactly once', () => {
  assert.deepEqual(
    cacheAwareArgs(['pack:spec'], {
      env: {},
      node: '/node',
      script: '/repo/scripts/run-shifu-lifecycle.mjs',
    }),
    [
      'cache',
      'apply',
      '--',
      '/node',
      '/repo/scripts/run-shifu-lifecycle.mjs',
      'direct',
      'pack:spec',
    ],
  );
});

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
    cmdCommand('shifu.cmd', ['verify', '--fuzz']),
    'shifu.cmd verify --fuzz',
  );
  assert.equal(
    cmdCommand('C:\\repo path\\shifu.cmd', ['install', '--frozen-lockfile']),
    '"C:\\repo path\\shifu.cmd" install --frozen-lockfile',
  );
  assert.throws(
    () => cmdCommand('C:\\repo\\shifu.cmd', ['task%PATH%']),
    /unsafe cmd syntax/,
  );
});

test('enters a Windows batch shim with one fully quoted cmd payload', () => {
  assert.deepEqual(
    windowsCmdArgs('C:\\repo path\\shifu.cmd', [
      'cache',
      'apply',
      '--',
      'C:\\Program Files\\node.exe',
    ]),
    [
      '/d',
      '/s',
      '/c',
      '""C:\\repo path\\shifu.cmd" "cache" "apply" "--" "C:\\Program Files\\node.exe""',
    ],
  );
  assert.throws(
    () => windowsCmdArgs('shifu.cmd', ['task&whoami']),
    /unsafe cmd syntax/,
  );
});

test(
  'Windows preserves a multi-argument Shifu batch invocation',
  { skip: process.platform !== 'win32' },
  () => {
    const lifecycle = fileURLToPath(
      new URL('./run-shifu-lifecycle.mjs', import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [lifecycle, 'direct', '--version'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: process.env,
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /^shifu \S+ \(git [^)]+\)$/mu);
  },
);

test(
  'Windows cold source launcher forwards the original lifecycle arguments',
  { skip: process.platform !== 'win32' },
  (t) => {
    const cache = fs.mkdtempSync(
      path.join(os.tmpdir(), 'shifu-cold-dispatch-'),
    );
    t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
    const lifecycle = fileURLToPath(
      new URL('./run-shifu-lifecycle.mjs', import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [lifecycle, 'direct', 'cache', 'schema', 'profile'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          XDG_CACHE_HOME: cache,
          SHIFU_BIN: '',
          SHIFU_NATIVE: '1',
        },
        windowsHide: true,
      },
    );
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.equal(
      JSON.parse(result.stdout).$id,
      'https://libkungfu.dev/schemas/shifu/cache-profile-v1.schema.json',
    );
  },
);
