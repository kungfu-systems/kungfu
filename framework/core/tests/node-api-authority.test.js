// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const coreDir = path.resolve(__dirname, '..');
const authority = require('../node-api-authority.json');
const createKungfuRuntime = require('../lib/kungfu');

function classifiedNames() {
  return Object.values(authority.categories).flat().sort();
}

test('Node API authority classifies every name exactly once', () => {
  const names = classifiedNames();
  assert.equal(new Set(names).size, names.length);
  assert.equal(authority.policy.unclassifiedExportsAllowed, false);
  assert.equal(authority.policy.publicNativeOperationsMaySpawnCli, false);

  const generated = fs.readFileSync(
    path.join(coreDir, authority.generatedDeclaration),
    'utf8',
  );
  for (const name of names) {
    assert.match(generated, new RegExp(`readonly ${name}: unknown;`, 'u'));
  }
});

test('built native addon exports exactly the classified authority', (t) => {
  const addon = path.join(coreDir, authority.nativeAddon);
  if (!fs.existsSync(addon)) {
    t.skip('native addon is not built in this source checkout');
    return;
  }

  const nativeExports = Object.keys(require(addon)).sort();
  assert.deepEqual(nativeExports, classifiedNames());
});

test('public native operations stay in-process and do not spawn the CLI', (t) => {
  const addon = path.join(coreDir, authority.nativeAddon);
  if (!fs.existsSync(addon)) {
    t.skip('native addon is not built in this source checkout');
    return;
  }

  const original = {};
  const spawnMethods = ['spawn', 'spawnSync', 'exec', 'execFile', 'fork'];
  for (const method of spawnMethods) {
    original[method] = childProcess[method];
    childProcess[method] = () => {
      throw new Error(`unexpected child_process.${method}`);
    };
  }
  try {
    const runtime = createKungfuRuntime();
    const publicNames = [
      ...authority.categories.factoryWrapped,
      ...authority.categories.nativeDirect,
      ...authority.categories.compatibilityOnly,
    ];
    for (const name of publicNames) {
      assert.notEqual(
        runtime[name],
        undefined,
        `missing public export ${name}`,
      );
    }
    const capabilities = runtime.storageServiceCapabilities();
    assert.equal(typeof capabilities, 'object');
  } finally {
    for (const method of spawnMethods) childProcess[method] = original[method];
  }
});
