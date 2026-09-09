// SPDX-License-Identifier: Apache-2.0

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  auditPackagedApp,
  repairNodePtySpawnHelpers,
} = require('./bundle-core-audit.cjs');

function packagedAppFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-bundle-audit-'));
  const app = path.join(root, 'Kungfu.app');
  const resources = path.join(app, 'Contents', 'Resources');
  const runtime = path.join(resources, 'kungfu');
  const helper = path.join(
    resources,
    'app',
    'node_modules',
    'node-pty',
    'prebuilds',
    'darwin-arm64',
    'spawn-helper',
  );
  const appRoot = path.join(resources, 'app');
  const main = path.join(appRoot, 'out', 'main', 'index.js');
  const agentSessionPackage = path.join(
    appRoot,
    'node_modules',
    '@kungfu-tech',
    'agent-session',
  );
  fs.mkdirSync(runtime, { recursive: true });
  for (const name of [
    'kungfu',
    'kungfu_electron.node',
    'libkungfu.dylib',
    'libkungfu_runtime.dylib',
    'profile-kfd3.json',
  ]) {
    fs.writeFileSync(path.join(runtime, name), 'fixture');
  }
  fs.mkdirSync(path.dirname(helper), { recursive: true });
  fs.writeFileSync(helper, 'fixture', { mode: 0o644 });
  fs.mkdirSync(path.dirname(main), { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, 'package.json'),
    JSON.stringify({ main: 'out/main/index.js' }),
  );
  fs.writeFileSync(main, 'require("electron"); require("node:path");');
  fs.mkdirSync(path.join(agentSessionPackage, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(agentSessionPackage, 'package.json'),
    JSON.stringify({
      name: '@kungfu-tech/agent-session',
      version: '0.0.0',
      type: 'module',
      exports: { './product-client': './src/product-client.mjs' },
    }),
  );
  fs.writeFileSync(
    path.join(agentSessionPackage, 'src', 'product-client.mjs'),
    '',
  );
  fs.writeFileSync(
    path.join(agentSessionPackage, 'src', 'product-worker.mjs'),
    '',
  );
  return { root, app, appRoot, helper, main, agentSessionPackage };
}

test(
  'repairs and audits the packaged node-pty Darwin spawn helper',
  { skip: process.platform === 'win32' },
  (t) => {
    const fixture = packagedAppFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

    assert.throws(
      () => auditPackagedApp(fixture.app),
      /non-executable node-pty Darwin spawn-helper/,
    );
    repairNodePtySpawnHelpers(fixture.app);
    assert.notEqual(fs.statSync(fixture.helper).mode & 0o111, 0);
    assert.doesNotThrow(() => auditPackagedApp(fixture.app));
  },
);

test(
  'Windows audits Darwin bundles without emulated executable mode claims',
  { skip: process.platform !== 'win32' },
  (t) => {
    const fixture = packagedAppFixture();
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

    assert.doesNotThrow(() => auditPackagedApp(fixture.app));
  },
);

test('rejects an app without the detached Agent Session worker', (t) => {
  const fixture = packagedAppFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  repairNodePtySpawnHelpers(fixture.app);
  fs.rmSync(
    path.join(fixture.agentSessionPackage, 'src', 'product-worker.mjs'),
  );
  assert.throws(
    () => auditPackagedApp(fixture.app),
    /missing packaged Agent Session runtime file/,
  );
});

test('rejects an external main dependency missing from the packaged app', (t) => {
  const fixture = packagedAppFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  repairNodePtySpawnHelpers(fixture.app);
  fs.writeFileSync(
    fixture.main,
    'require("@kungfu-tech/missing-runtime/entry");',
  );

  assert.throws(
    () => auditPackagedApp(fixture.app),
    /unresolved packaged main dependencies:[\s\S]+missing-runtime\/entry/,
  );
});

test('accepts a packaged external main dependency', (t) => {
  const fixture = packagedAppFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  repairNodePtySpawnHelpers(fixture.app);
  fs.writeFileSync(
    fixture.main,
    'require("@kungfu-tech/agent-session/product-client");',
  );

  assert.doesNotThrow(() => auditPackagedApp(fixture.app));
});
