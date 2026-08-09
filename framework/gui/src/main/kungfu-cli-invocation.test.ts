import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { resolveGuiKungfuCliInvocation } from './profile-cli.ts';

const coreDir = path.resolve('/workspace/framework/core');
const runtimeDir = path.join(coreDir, 'dist', 'kungfu');
const sourceMain = path.join(coreDir, 'src', 'python', 'kungfu', '__main__.py');

test('GUI keeps an explicit available CLI binary unchanged', () => {
  const invocation = resolveGuiKungfuCliInvocation({
    env: { KUNGFU_CLI_BIN: '/installed/kungfu' },
    runtimeDir,
    platform: 'darwin',
    exists: (candidate) => candidate === '/installed/kungfu',
  });

  assert.deepEqual(invocation, {
    bin: '/installed/kungfu',
    argsPrefix: [],
    env: {},
    source: 'configured',
  });
});

test('GUI dev falls back to the source CLI when the adjacent binary is absent', () => {
  const invocation = resolveGuiKungfuCliInvocation({
    env: {
      KUNGFU_CLI_BIN: path.join(runtimeDir, 'kungfu'),
      PYTHONPATH: '/existing/python',
    },
    runtimeDir,
    platform: 'darwin',
    exists: (candidate) => candidate === sourceMain,
  });

  assert.equal(invocation.bin, 'uv');
  assert.deepEqual(invocation.argsPrefix, [
    'run',
    '--project',
    coreDir,
    '--frozen',
    'python',
    '-m',
    'kungfu',
  ]);
  assert.equal(invocation.source, 'source-python');
  assert.equal(
    invocation.env.PYTHONPATH,
    [
      path.join(coreDir, 'src', 'python'),
      path.join(coreDir, 'build', 'Release'),
      '/existing/python',
    ].join(path.delimiter),
  );
});

test('GUI packaged runtime keeps the adjacent executable', () => {
  const packaged = path.join(runtimeDir, 'kungfu');
  const resourcesPath = path.resolve('/Applications/Kungfu.app/Resources');
  const manifest = path.join(
    resourcesPath,
    'upgrade',
    'kungfu-release-manifest.json',
  );
  const invocation = resolveGuiKungfuCliInvocation({
    env: {},
    runtimeDir,
    platform: 'darwin',
    isPackaged: true,
    resourcesPath,
    exists: (candidate) => candidate === packaged || candidate === manifest,
  });

  assert.equal(invocation.bin, packaged);
  assert.deepEqual(invocation.argsPrefix, []);
  assert.deepEqual(invocation.env, {
    KUNGFU_DIR: runtimeDir,
    KUNGFU_INSTALL_SOURCE: 'desktop-companion',
    KUNGFU_UPGRADE_MANIFEST: manifest,
  });
  assert.equal(invocation.source, 'adjacent-runtime');
});

test('GUI development does not claim installed-product provenance', () => {
  const packaged = path.join(runtimeDir, 'kungfu');
  const invocation = resolveGuiKungfuCliInvocation({
    env: {},
    runtimeDir,
    platform: 'darwin',
    exists: (candidate) => candidate === packaged,
  });

  assert.deepEqual(invocation.env, {});
  assert.equal(invocation.source, 'adjacent-runtime');
});

test('GUI relaunch restores packaged provenance for its inherited adjacent CLI', () => {
  const packaged = path.join(runtimeDir, 'kungfu');
  const resourcesPath = path.resolve('/Applications/Kungfu.app/Resources');
  const manifest = path.join(
    resourcesPath,
    'upgrade',
    'kungfu-release-manifest.json',
  );
  const invocation = resolveGuiKungfuCliInvocation({
    env: { KUNGFU_CLI_BIN: packaged },
    runtimeDir,
    platform: 'darwin',
    isPackaged: true,
    resourcesPath,
    exists: (candidate) => candidate === packaged || candidate === manifest,
  });

  assert.equal(invocation.source, 'configured');
  assert.deepEqual(invocation.env, {
    KUNGFU_DIR: runtimeDir,
    KUNGFU_INSTALL_SOURCE: 'desktop-companion',
    KUNGFU_UPGRADE_MANIFEST: manifest,
  });
});
