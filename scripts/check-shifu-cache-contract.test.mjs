// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkShifuCacheContract } from './check-shifu-cache-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFU_MJS = path.join(ROOT, 'shifu.mjs');

test('cache contract schemas accept valid fixtures and reject unsafe policy', () => {
  assert.deepEqual(checkShifuCacheContract(ROOT), {
    contract: 'docs/shifu/cache-contract.json',
    profileSchema: 'docs/shifu/schema/cache-profile-v1.schema.json',
    resolutionSchema: 'docs/shifu/schema/cache-resolution-v1.schema.json',
    validFixtures: 3,
    rejectedFixtures: 2,
  });
});

for (const [label, args, source] of [
  ['contract', ['cache', 'contract'], 'docs/shifu/cache-contract.json'],
  [
    'profile schema',
    ['cache', 'schema', 'profile'],
    'docs/shifu/schema/cache-profile-v1.schema.json',
  ],
  [
    'resolution schema',
    ['cache', 'schema', 'resolution'],
    'docs/shifu/schema/cache-resolution-v1.schema.json',
  ],
]) {
  test(`shifu exposes the exact checked-in ${label}`, () => {
    const result = spawnSync(process.execPath, [SHIFU_MJS, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      fs.readFileSync(path.join(ROOT, source), 'utf8'),
    );
  });
}

test('unknown cache schema fails with usage', () => {
  const result = spawnSync(
    process.execPath,
    [SHIFU_MJS, 'cache', 'schema', 'unknown'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /cache schema profile/);
});

test('shifu validates a profile through its runtime authority', () => {
  const profile = path.join(
    ROOT,
    'docs',
    'shifu',
    'examples',
    'development.cache-profile.json',
  );
  const result = spawnSync(
    process.execPath,
    [SHIFU_MJS, 'cache', 'validate', 'profile', profile],
    { cwd: ROOT, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).valid, true);
});

test('cache apply is transparent when no profile projection is configured', () => {
  const result = spawnSync(
    process.execPath,
    [
      SHIFU_MJS,
      'cache',
      'apply',
      '--',
      process.execPath,
      '-e',
      'process.stdout.write("cache-pass-through")',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        SHIFU_CACHE_PROFILE_REF: '',
        SHIFU_CACHE_PROFILE_DIGEST: '',
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'cache-pass-through');
});
