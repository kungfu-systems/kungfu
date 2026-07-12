// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkRoot, scanText } from './check-shifu-entry-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('accepts Shifu commands in participant documentation', () => {
  assert.deepEqual(
    scanText('AGENTS.md', '```sh\n./shifu build\n./shifu check\n```\n'),
    [],
  );
});

test('rejects direct package-manager commands in participant documentation', () => {
  const findings = scanText('AGENTS.md', '```sh\npnpm build\n```\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].tool, 'pnpm');
  assert.equal(findings[0].line, 2);
});

test('rejects direct node in a workflow run block', () => {
  const findings = scanText(
    '.github/workflows/example.yml',
    'steps:\n  - run: |\n      node scripts/build.mjs\n',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].tool, 'node');
});

test('allows one explicitly justified implementation command', () => {
  const findings = scanText(
    '.github/workflows/example.yml',
    'steps:\n  - run: |\n      # shifu-entry-contract: allow launcher release bootstrap\n      node scripts/release-launcher.mjs\n      node scripts/build.mjs\n',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 5);
});

test('current participant surfaces satisfy the contract', () => {
  assert.deepEqual(checkRoot(ROOT), []);
});

test('runtime guard rejects a direct task and accepts Shifu provenance', () => {
  const guard = path.join(ROOT, 'scripts', 'require-shifu.mjs');
  const rejected = spawnSync(process.execPath, [guard, 'build:core'], {
    encoding: 'utf8',
    env: { ...process.env, SHIFU_ENTRYPOINT: '' },
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Run: \.\/shifu build:core/);

  const accepted = spawnSync(process.execPath, [guard, 'build:core'], {
    encoding: 'utf8',
    env: { ...process.env, SHIFU_ENTRYPOINT: '1' },
  });
  assert.equal(accepted.status, 0);
});

test('package manager cannot run a guarded root task without Shifu', () => {
  const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
  const direct = spawnSync(corepack, ['pnpm', 'run', 'check:entry-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SHIFU_ENTRYPOINT: '' },
    shell: process.platform === 'win32',
  });
  assert.equal(direct.status, 1);
  assert.match(
    `${direct.stdout}\n${direct.stderr}`,
    /Direct package-manager invocation is unsupported/,
  );
  assert.match(
    `${direct.stdout}\n${direct.stderr}`,
    /\.\/shifu check:entry-contract/,
  );
});
