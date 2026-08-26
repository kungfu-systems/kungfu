// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  qualifyProductCacheHome,
  treeDigest,
} from './qualify-product-cache-home.mjs';

function fixtureApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-cache-fixture-'));
  const app = path.join(root, 'Kungfu Episodes.app');
  const cli = path.join(app, 'Contents', 'Resources', 'kungfu', 'kungfu');
  const gui = path.join(app, 'Contents', 'MacOS', 'Kungfu Episodes');
  const manifest = path.join(
    app,
    'Contents',
    'Resources',
    'upgrade',
    'kungfu-release-manifest.json',
  );
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.mkdirSync(path.dirname(gui), { recursive: true });
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(cli, 'fixture executable\n');
  fs.writeFileSync(gui, 'fixture desktop executable\n');
  fs.writeFileSync(
    manifest,
    JSON.stringify({ runtimeBuildId: 'runtime-fixture' }),
  );
  return app;
}

function successfulRunCommand(app, { mutateWorkDesign = false } = {}) {
  return (_command, args, options) => {
    const nativeNode = options.env.KUNGFU_AS_VARIANT === 'node';
    const workDesign = args.includes('work-design');
    const manualWorkDesign =
      workDesign &&
      args.some((value) => path.basename(value) === 'work-design-manual.json');
    const prefix = nativeNode
      ? path.join(
          options.env.HOME,
          'Library',
          'Caches',
          'kungfu',
          'python',
          'runtime-fixture',
        )
      : path.join(options.env.KF_CACHE_HOME, 'python', 'runtime-fixture');
    fs.mkdirSync(prefix, { recursive: true });
    fs.writeFileSync(path.join(prefix, 'module.pyc'), 'bytecode');
    if (workDesign && mutateWorkDesign) {
      fs.writeFileSync(
        path.join(app, 'Contents', 'work-design-side-effect'),
        'unexpected write',
      );
    }
    return {
      status: 0,
      stdout: nativeNode
        ? 'KF_NATIVE_NODE_CACHE_READY\n'
        : workDesign
          ? JSON.stringify(
              manualWorkDesign
                ? {
                    outcome: 'manual-capture',
                    adoption: { adopted: false },
                    fallback: { silentAdoption: false },
                  }
                : {
                    outcome: 'advisory-auto-adopted',
                    operation: { mutates: false },
                    authority: { assignment: false },
                  },
            )
          : args.length === 0
            ? 'KF_GUI_QUALIFICATION_READY\n'
            : 'brief',
      stderr: '',
    };
  };
}

test('qualification proves external bytecode without changing the app tree', () => {
  const app = fixtureApp();
  const before = treeDigest(app);
  const report = qualifyProductCacheHome({
    app,
    verifySignature: false,
    runCommand: successfulRunCommand(app),
  });
  assert.equal(report.qualified, true);
  assert.equal(report.appDigest, before);
  assert.equal(report.pythonBytecodeFiles, 1);
  assert.equal(report.checks.packagedGuiBoot, true);
  assert.equal(report.checks.nativeNodeWorkerCacheBootstrap, true);
  assert.equal(report.checks.installedWorkDesignPreflight, true);
  assert.equal(report.checks.workDesignManualCaptureExplicit, true);
  assert.equal(treeDigest(app), before);
});

test('qualification rejects a Work Design preflight that changes the app tree', () => {
  const app = fixtureApp();
  assert.throws(
    () =>
      qualifyProductCacheHome({
        app,
        verifySignature: false,
        runCommand: successfulRunCommand(app, { mutateWorkDesign: true }),
      }),
    /application tree changed after CLI use/u,
  );
});

test('qualification rejects bytecode shipped inside the app', () => {
  const app = fixtureApp();
  const pycache = path.join(
    app,
    'Contents',
    'Resources',
    'kungfu',
    '__pycache__',
  );
  fs.mkdirSync(pycache, { recursive: true });
  fs.writeFileSync(path.join(pycache, 'module.pyc'), 'bytecode');
  assert.throws(
    () => qualifyProductCacheHome({ app, verifySignature: false }),
    /already contains Python bytecode/u,
  );
});
