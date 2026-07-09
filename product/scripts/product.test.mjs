// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  devKfdEnv,
  instanceEnv,
  instanceHomeForWorktree,
  parseArgs,
  resolveInstanceHome,
  seedInstanceConfig,
} from './product.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..', '..');

test('parses an isolated instance home for product commands', () => {
  const parsed = parseArgs([
    'gui',
    'dev',
    '--instance-home',
    '~/kungfu-demo',
    '--dry-run',
  ]);
  assert.equal(parsed.dryRun, true);
  assert.deepEqual(parsed.positional, ['gui', 'dev']);
  assert.equal(parsed.instanceHome, path.join(homedir(), 'kungfu-demo'));
  assert.equal(parsed.noInstanceHome, false);
});

test('parses the dev auto-instance opt-out flag', () => {
  const parsed = parseArgs(['gui', 'dev', '--no-instance-home']);
  assert.deepEqual(parsed.positional, ['gui', 'dev']);
  assert.equal(parsed.noInstanceHome, true);
});

test('builds a consistent Kungfu instance environment', () => {
  const home = resolveInstanceHome('relative-kungfu-home');
  const env = instanceEnv(home, { PATH: '/bin' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.KF_INSTANCE_HOME, home);
  assert.equal(env.KF_HOME, path.join(home, 'home'));
  assert.equal(env.KF_CONFIG_HOME, path.join(home, 'config'));
  assert.equal(env.KF_RUNTIME_DIR, path.join(home, 'home', 'runtime'));
});

test('derives a stable auto instance root from a worktree path', () => {
  const root = path.join(tmpdir(), 'kungfu feature spaces', 'demo-worktree');
  const home = instanceHomeForWorktree(root, {
    KF_AUTO_INSTANCE_ROOT: path.join(tmpdir(), 'kf-instances'),
  });
  assert.match(
    home,
    new RegExp(
      `${escapeRegExp(path.join(tmpdir(), 'kf-instances', 'worktrees'))}${escapeRegExp(path.sep)}demo-worktree-[0-9a-f]{10}$`,
    ),
  );
});

test('defaults auto instance homes under the config root', () => {
  const root = path.join(tmpdir(), 'kungfu-feature', 'demo-worktree');
  const home = instanceHomeForWorktree(root, {});
  assert.match(
    home,
    new RegExp(
      `${escapeRegExp(path.join(homedir(), '.kungfu-config', 'instances', 'worktrees'))}${escapeRegExp(path.sep)}demo-worktree-[0-9a-f]{10}$`,
    ),
  );
});

test('seeds default config into a fresh instance without overwriting it', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'kungfu-product-seed-'));
  const sourceHome = path.join(parent, 'default-config');
  const instanceHome = path.join(parent, 'instance');
  mkdirSync(sourceHome, { recursive: true });
  writeFileSync(
    path.join(sourceHome, 'config.json'),
    '{"schema":"kungfu.config.override/v1","ui":{"scale":1.1}}\n',
  );
  try {
    const first = seedInstanceConfig(instanceHome, {
      sourceConfigHome: sourceHome,
    });
    const target = path.join(instanceHome, 'config', 'config.json');
    assert.equal(first.seeded, true);
    assert.equal(
      readFileSync(target, 'utf8'),
      readFileSync(first.source, 'utf8'),
    );

    writeFileSync(
      target,
      '{"schema":"kungfu.config.override/v1","ui":{"scale":2}}\n',
    );
    writeFileSync(
      path.join(sourceHome, 'config.json'),
      '{"schema":"kungfu.config.override/v1","ui":{"scale":3}}\n',
    );
    const second = seedInstanceConfig(instanceHome, {
      sourceConfigHome: sourceHome,
    });
    assert.equal(second.seeded, false);
    assert.equal(second.reason, 'target-exists');
    assert.match(readFileSync(target, 'utf8'), /"scale":2/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('dry-run shows instance env without creating the home', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'kungfu-product-test-'));
  const home = path.join(parent, 'instance-a');
  try {
    const result = spawnSync(
      process.execPath,
      [
        __filename.replace(/\.test\.mjs$/, '.mjs'),
        'gui',
        'dev',
        '-H',
        home,
        '--dry-run',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      result.stdout,
      new RegExp(`KF_HOME=${escapeRegExp(path.join(home, 'home'))}`),
    );
    assert.match(
      result.stdout,
      new RegExp(`KF_CONFIG_HOME=${escapeRegExp(path.join(home, 'config'))}`),
    );
    assert.match(
      result.stdout,
      new RegExp(
        `KF_RUNTIME_DIR=${escapeRegExp(path.join(home, 'home', 'runtime'))}`,
      ),
    );
    assert.match(result.stdout, /pnpm --filter @kungfu-tech\/gui run dev/);
    assert.equal(existsSync(home), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('dev product commands expose local KFD metadata to kungfu kfd', () => {
  const result = spawnSync(
    process.execPath,
    [__filename.replace(/\.test\.mjs$/, '.mjs'), 'gui', 'dev', '--dry-run'],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    result.stdout,
    new RegExp(
      `KUNGFU_SDK_ENTRY=${escapeRegExp(path.join(ROOT, 'developer', 'sdk', 'src', 'sdk.js'))}`,
    ),
  );
  assert.match(
    result.stdout,
    new RegExp(
      `KUNGFU_KFD3_REGISTRY=${escapeRegExp(path.join(ROOT, '.buildchain', 'kfd', 'kfd-3-surfaces.json'))}`,
    ),
  );
  assert.match(
    result.stdout,
    new RegExp(
      `KUNGFU_KFD_UPSTREAM_AGGREGATE=${escapeRegExp(path.join(ROOT, 'developer', 'sdk', 'kfd', 'upstream-aggregate.json'))}`,
    ),
  );
});

test('dev KFD environment preserves explicit user overrides', () => {
  const env = devKfdEnv({
    KUNGFU_SDK_ENTRY: '/custom/sdk.js',
    KUNGFU_KFD3_REGISTRY: '/custom/kfd3.json',
    KUNGFU_KFD_UPSTREAM_AGGREGATE: '/custom/upstream.json',
  });
  assert.equal(env.KUNGFU_SDK_ENTRY, '/custom/sdk.js');
  assert.equal(env.KUNGFU_KFD3_REGISTRY, '/custom/kfd3.json');
  assert.equal(env.KUNGFU_KFD_UPSTREAM_AGGREGATE, '/custom/upstream.json');
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
