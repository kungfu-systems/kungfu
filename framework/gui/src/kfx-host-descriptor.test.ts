// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  kfxNativePlanArgs,
  resolveKfxHostDescriptor,
} from './renderer/src/projects-panel/index.tsx';

const nativeDescriptor = {
  schema: 'kungfu.kfx.experience-flow-descriptor/v1',
  descriptorRoot: 'sha256:native',
  admission: { state: 'admitted' },
};
const cliDescriptor = {
  schema: 'kungfu.kfx.experience-flow-descriptor/v1',
  descriptorRoot: 'sha256:cli',
  admission: { state: 'admitted' },
};

test('native KFX authority remains preferred when the Project runtime is live', () => {
  let cliCalls = 0;
  const resolved = resolveKfxHostDescriptor({
    nativePlan: () => ({ hostContract: nativeDescriptor }),
    cliPlan: () => {
      cliCalls += 1;
      return { hostContract: cliDescriptor };
    },
  });
  assert.equal(resolved?.descriptorRoot, 'sha256:native');
  assert.equal(cliCalls, 0);
});

test('Core CLI supplies the exact descriptor when retained Project native storage is offline', () => {
  const resolved = resolveKfxHostDescriptor({
    nativePlan: () => {
      throw new Error('master unavailable');
    },
    cliPlan: () => ({ hostContract: cliDescriptor }),
  });
  assert.equal(resolved?.descriptorRoot, 'sha256:cli');
});

test('preview-only discovery never becomes a GUI execution descriptor', () => {
  const resolved = resolveKfxHostDescriptor({
    nativePlan: () => ({
      hostContract: {
        ...nativeDescriptor,
        admission: { state: 'preview-only' },
      },
    }),
    cliPlan: () => ({
      hostContract: {
        ...cliDescriptor,
        admission: { state: 'preview-only' },
      },
    }),
  });
  assert.equal(resolved, null);
});

test('CLI fallback keeps bundled and user extension authority roots distinct', () => {
  const args = kfxNativePlanArgs(
    {
      KF_BUNDLED_EXTENSION_ROOT: '/product/extensions',
      KF_EXTENSION_PATH: ['/product/extensions', '/user/extra-extensions'].join(
        path.delimiter,
      ),
      KF_RUNTIME_DIR: '/project/.kungfu/runtime',
    },
    path,
  );
  assert.deepEqual(args, [
    'kfx',
    'native',
    'plan',
    '--root',
    `product=${path.resolve('/product/extensions')}`,
    '--root',
    `user=${path.resolve('/user/extra-extensions')}`,
    '--root',
    `user=${path.resolve('/project/.kungfu/extensions')}`,
  ]);
});

test('CLI fallback omits a Project extension root that is not installed', () => {
  const productRoot = path.resolve('/product/extensions');
  const args = kfxNativePlanArgs(
    {
      KF_BUNDLED_EXTENSION_ROOT: productRoot,
      KF_EXTENSION_PATH: productRoot,
      KF_RUNTIME_DIR: '/project/.kungfu/runtime',
    },
    path,
    (candidate) => candidate === productRoot,
  );
  assert.deepEqual(args, [
    'kfx',
    'native',
    'plan',
    '--root',
    `product=${productRoot}`,
  ]);
});
