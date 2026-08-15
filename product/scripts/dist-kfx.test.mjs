// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';
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
