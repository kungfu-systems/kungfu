// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { repairInvalidUvEnvironment } = require('../.gyp/run-conan');

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
