// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  assertDeclaredKfx,
  isKfxPackageName,
  listKfxPackages,
} from './dist.mjs';

test('product KFX discovery accepts public and first-party package scopes', () => {
  assert.equal(isKfxPackageName('@kungfu-tech/kfx-view-status'), true);
  assert.equal(isKfxPackageName('@kungfu-kfx/github-webhook-ingress'), true);
  assert.equal(isKfxPackageName('@kungfu-tech/core'), false);
  assert.equal(isKfxPackageName('@example/kfx-extension'), false);
  assert.doesNotThrow(() => assertDeclaredKfx(listKfxPackages()));
});

test('root build uses the same reference-only product assembly policy', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../../scripts/build.mjs', import.meta.url)),
      '--dry-run',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /product-bundled KFX packages: \d+/u);
  assert.doesNotMatch(result.stdout, /github-webhook|github-dogfood-bridge/u);
});
