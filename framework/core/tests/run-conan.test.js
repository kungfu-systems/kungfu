// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  conanBuildJobsConf,
  conanMsvcVersionFromBanner,
  repairInvalidUvEnvironment,
} = require('../.gyp/run-conan');

test('projects one validated build budget into Conan dependency builds', () => {
  assert.deepEqual(conanBuildJobsConf({}), []);
  assert.deepEqual(conanBuildJobsConf({ KUNGFU_BUILD_JOBS: ' 2 ' }), [
    '-c',
    'tools.build:jobs=2',
  ]);
  assert.throws(
    () => conanBuildJobsConf({ KUNGFU_BUILD_JOBS: 'two' }),
    /must be a positive integer/,
  );
  assert.throws(
    () => conanBuildJobsConf({ KUNGFU_BUILD_JOBS: '0' }),
    /must be a positive integer/,
  );
});

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-uv-environment-'));
}

test('removes an incomplete generated uv environment', () => {
  const root = fixture();
  const venv = path.join(root, '.venv');
  fs.mkdirSync(venv);
  fs.writeFileSync(path.join(venv, 'partial-install'), 'incomplete');

  assert.equal(repairInvalidUvEnvironment(root, 'darwin'), true);
  assert.equal(fs.existsSync(venv), false);
});

test('preserves a uv environment with its platform Python executable', () => {
  const root = fixture();
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, 'python');

  assert.equal(repairInvalidUvEnvironment(root, 'win32'), false);
  assert.equal(fs.existsSync(python), true);
});

test('refuses to replace an invalid uv environment symlink', () => {
  const root = fixture();
  const target = path.join(root, 'target');
  fs.mkdirSync(target);
  fs.symlinkSync(
    target,
    path.join(root, '.venv'),
    process.platform === 'win32' ? 'junction' : undefined,
  );

  assert.throws(
    () => repairInvalidUvEnvironment(root, 'darwin'),
    /refusing to replace invalid uv environment/,
  );
  assert.equal(fs.existsSync(target), true);
});

test('binds Conan dependency identity to the active MSVC toolset', () => {
  assert.equal(
    conanMsvcVersionFromBanner(
      'Microsoft (R) C/C++ Optimizing Compiler Version 19.44.35207 for x64',
    ),
    '194',
  );
  assert.equal(
    conanMsvcVersionFromBanner(
      '用于 x64 的 Microsoft (R) C/C++ 优化编译器 19.51.36248 版',
    ),
    '195',
  );
  assert.throws(
    () => conanMsvcVersionFromBanner('unexpected compiler banner'),
    /cannot map the active MSVC banner/,
  );
});
