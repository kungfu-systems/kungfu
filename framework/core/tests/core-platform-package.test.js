// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const contract = require('../core-platform-package.contract.json');
const sourcePackage = require('../package.json');
const stdlibPrune = require('../../../product/stdlib-prune.json');
const {
  platformPackages,
  resolveExecutable,
  resolveRuntimeDir,
} = require('../lib/platform-packages');
const {
  linuxReleaseStripCandidates,
  resolvePackageStageDir,
} = require('../.gyp/core-platform-package');

test('explicit package stage paths resolve from the repository root', () => {
  const repositoryRoot = path.resolve(__dirname, '..', '..', '..');

  assert.equal(
    resolvePackageStageDir('product/release/npm'),
    path.join(repositoryRoot, 'product', 'release', 'npm'),
  );
  assert.equal(
    resolvePackageStageDir(undefined),
    path.join(repositoryRoot, 'framework', 'core', 'build', 'stage', 'npm'),
  );
});

test('Core platform package authority is exact and source package is neutral', () => {
  assert.deepEqual(platformPackages, contract.platformPackages);
  assert.deepEqual(
    platformPackages.map((item) => item.name),
    [
      '@kungfu-tech/core-darwin-arm64',
      '@kungfu-tech/core-linux-x64',
      '@kungfu-tech/core-linux-arm64',
      '@kungfu-tech/core-win32-x64',
    ],
  );
  assert.equal(sourcePackage.files.includes('dist/kungfu'), false);
  assert.equal(sourcePackage.scripts.install, 'node .gyp/noop-install.js');
  assert.equal(
    sourcePackage.scripts.prepack,
    'node .gyp/refuse-source-pack.js',
  );
  assert.equal(sourcePackage.optionalDependencies, undefined);
});

test('platform payload contract accepts native libnode filenames', () => {
  const libnodePattern = contract.platformPayload.requiredPathPatterns.find(
    (pattern) => pattern.includes('libnode'),
  );
  const matchesLibnode = new RegExp(libnodePattern, 'u');

  assert.equal(matchesLibnode.test('dist/kungfu/libnode.127.dylib'), true);
  assert.equal(matchesLibnode.test('dist/kungfu/libnode.so.127'), true);
  assert.equal(matchesLibnode.test('dist/kungfu/libnode.dll'), true);
  assert.equal(matchesLibnode.test('dist/kungfu/libnode.127.so'), false);
});

test('platform package budget preserves its bounded bands', () => {
  assert.equal(
    contract.sizePolicy.compressedHardCeilingBytes,
    100 * 1024 * 1024,
  );
  assert.ok(
    contract.sizePolicy.compressedOptimizationTargetBytes <
      contract.sizePolicy.compressedNormalCeilingBytes,
  );
  assert.ok(
    contract.sizePolicy.compressedNormalCeilingBytes <
      contract.sizePolicy.compressedHardCeilingBytes,
  );
  assert.equal(contract.sizePolicy.hardCeilingExceptionRequiresReview, true);
});

test('Linux package prunes the unused dbm accelerator before size enforcement', () => {
  const dbmAccelerator = 'lib/python3.13/lib-dynload/_dbm*';
  assert.ok(stdlibPrune.prune.linux.includes(dbmAccelerator));
  assert.equal(stdlibPrune.prune.darwin.includes(dbmAccelerator), false);
});

test('Linux Release stripping is explicit and excludes runtimes owned upstream', () => {
  assert.deepEqual(
    linuxReleaseStripCandidates([
      'dist/kungfu/python/bin/python3',
      'dist/kungfu/python/lib/python3.13/lib-dynload/_dbm.so',
      'dist/kungfu/libnode.so.127',
      'dist/kungfu/libkungfu_runtime.so',
      'dist/kungfu/kungfu_node.node',
      'dist/kungfu/kungfu_electron.node',
      'dist/kungfu/drone.node',
      'dist/kungfu/libwasm/libkungfu_libwasm_wasmtime.so',
      'dist/kungfu/kungfu-kfd-agent-runtime',
      'dist/kungfu/kungfu-trunk',
      'dist/kungfu/kungfu-wasm-host',
      'dist/kungfu/kungfu',
    ]),
    [
      'dist/kungfu/libkungfu_runtime.so',
      'dist/kungfu/kungfu_node.node',
      'dist/kungfu/kungfu_electron.node',
      'dist/kungfu/drone.node',
      'dist/kungfu/libwasm/libkungfu_libwasm_wasmtime.so',
      'dist/kungfu/kungfu-kfd-agent-runtime',
      'dist/kungfu/kungfu-trunk',
      'dist/kungfu/kungfu-wasm-host',
    ],
  );
});

test('one resolver owns explicit, platform-package, and executable paths', () => {
  assert.equal(
    resolveRuntimeDir({ env: { KUNGFU_DIR: '/tmp/kungfu-explicit' } }),
    path.resolve('/tmp/kungfu-explicit'),
  );
  assert.equal(
    resolveRuntimeDir({
      env: {},
      platform: 'linux',
      arch: 'x64',
      allowSourceFallback: false,
      loadPackage(name) {
        assert.equal(name, '@kungfu-tech/core-linux-x64');
        return { runtimeDir: '/opt/kungfu-runtime' };
      },
    }),
    path.resolve('/opt/kungfu-runtime'),
  );
  assert.equal(
    resolveExecutable('kungfu', {
      env: {},
      platform: 'win32',
      arch: 'x64',
      allowSourceFallback: false,
      loadPackage: () => ({ runtimeDir: 'C:\\kungfu-runtime' }),
    }),
    path.join(path.resolve('C:\\kungfu-runtime'), 'kungfu.exe'),
  );
});

test('resolver fails closed for unsupported or missing platform packages', () => {
  assert.throws(
    () =>
      resolveRuntimeDir({
        env: {},
        platform: 'aix',
        arch: 'ppc64',
        allowSourceFallback: false,
      }),
    /does not support aix-ppc64/u,
  );
  assert.throws(
    () =>
      resolveRuntimeDir({
        env: {},
        platform: 'linux',
        arch: 'x64',
        allowSourceFallback: false,
        loadPackage: () => {
          throw new Error('not installed');
        },
      }),
    /Missing @kungfu-tech\/core-linux-x64/u,
  );
});

test('source consumers can import Core before a platform package is installed', () => {
  const executable = require('../lib/executable');
  const descriptor = Object.getOwnPropertyDescriptor(executable, 'kfc');

  assert.equal(descriptor.enumerable, true);
  assert.equal(typeof descriptor.get, 'function');
  assert.equal(
    Object.prototype.hasOwnProperty.call(descriptor, 'value'),
    false,
  );
});
