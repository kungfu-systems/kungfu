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

test('Windows reuses a selected native launcher without a nested cmd shim', () => {
  const status = runShifu(['--version'], {
    platform: 'win32',
    root: process.cwd(),
    comspec: path.join(os.tmpdir(), 'missing-cmd.exe'),
    env: { ...process.env, SHIFU_BIN: process.execPath },
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
      '"call "C:\\repo path\\shifu.cmd" "cache" "apply" "--" "C:\\Program Files\\node.exe""',
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
    assert.doesNotMatch(result.stderr, /batch label specified/u);
    assert.match(result.stdout, /^shifu \S+ \(git [^)]+\)$/mu);
  },
);

test(
  'Windows cold, warm, explicit, and cache-applied launchers dispatch ordinary commands',
  { skip: process.platform !== 'win32' },
  (t) => {
    const cache = fs.mkdtempSync(
      path.join(os.tmpdir(), 'shifu-cold-dispatch-'),
    );
    t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
    const lifecycle = fileURLToPath(
      new URL('./run-shifu-lifecycle.mjs', import.meta.url),
    );
    const isolatedEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          ![
            'SHIFU_BIN',
            'SHIFU_CACHE_ACTIVE',
            'SHIFU_ENTRYPOINT',
            'SHIFU_FROM_SHIM',
            'SHIFU_NATIVE',
            'XDG_CACHE_HOME',
            'XDG_CONFIG_HOME',
          ].includes(name.toUpperCase()),
      ),
    );
    const invoke = (args, extraEnv = {}) =>
      spawnSync(process.execPath, [lifecycle, ...args], {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...isolatedEnv,
          XDG_CACHE_HOME: cache,
          XDG_CONFIG_HOME: path.join(cache, 'config'),
          SHIFU_NATIVE: '1',
          ...extraEnv,
        },
        windowsHide: true,
      });
    const assertDoctor = (result) => {
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.match(`${result.stdout}\n${result.stderr}`, /shifu doctor/u);
    };

    assertDoctor(invoke(['direct', 'doctor']));
    assertDoctor(invoke(['direct', 'doctor']));

    const inheritedBinary = Object.entries(process.env).find(
      ([name]) => name.toUpperCase() === 'SHIFU_BIN',
    )?.[1];
    const workspaceBinary = path.join(
      process.cwd(),
      'crates',
      'target',
      'release',
      'shifu.exe',
    );
    const sourceBinary =
      inheritedBinary && fs.existsSync(inheritedBinary)
        ? inheritedBinary
        : workspaceBinary;
    assert.ok(
      fs.existsSync(sourceBinary),
      'Windows lifecycle test needs the launcher built by shifu.workspace',
    );
    assertDoctor(
      invoke(['direct', 'doctor'], {
        SHIFU_BIN: sourceBinary,
      }),
    );
    assertDoctor(
      invoke(['cache-apply', 'doctor'], {
        SHIFU_BIN: sourceBinary,
      }),
    );
  },
);

test(
  'Windows lifecycle dispatch reaches an ordinary pnpm command',
  { skip: process.platform !== 'win32' },
  (t) => {
    const evidence = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-pnpm-dispatch-')),
      'evidence.txt',
    );
    t.after(() =>
      fs.rmSync(path.dirname(evidence), { recursive: true, force: true }),
    );
    const script =
      "require('node:fs').writeFileSync(process.env.SHIFU_TEST_EVIDENCE,'ok')";
    const status = runShifu(['exec', 'node', '-e', script], {
      platform: 'win32',
      root: process.cwd(),
      env: { ...process.env, SHIFU_TEST_EVIDENCE: evidence },
      stdio: 'ignore',
    });
    assert.equal(status, 0);
    assert.equal(fs.readFileSync(evidence, 'utf8'), 'ok');
  },
);
