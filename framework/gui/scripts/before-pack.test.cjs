// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { beforePackArgs } = require('./before-pack.cjs');

test('passes Windows ESM entrypoints as file URLs', () => {
  const loader = path.resolve('node_modules', 'tsx', 'dist', 'loader.mjs');
  const generator = path.resolve(
    'framework',
    'gui',
    'scripts',
    'gen-first-party-manifest.mjs',
  );

  const args = beforePackArgs(loader, generator, 'win32');

  assert.equal(args[0], '--import');
  assert.equal(new URL(args[1]).protocol, 'file:');
  assert.equal(args[2], '--eval');
  assert.match(args[3], /^import\("file:/);
});

test('upgrade manifest generation runs after runtime mutation hooks', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'before-pack.cjs'),
    'utf8',
  );
  assert.ok(
    source.indexOf('gen-upgrade-manifest.mjs') >
      source.indexOf('gen-system-profile-kfd3.mjs'),
  );
});
