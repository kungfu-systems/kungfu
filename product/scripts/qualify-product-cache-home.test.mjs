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

function successfulRunCommand(
  app,
  { inspectEnv = () => {}, mutateWorkDesign = false } = {},
) {
  return (_command, args, options) => {
    inspectEnv(options.env);
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

test('qualification strips hostile ambient runtime and module injection', () => {
  const app = fixtureApp();
  const hostile = path.join(path.dirname(app), 'hostile-development-tree');
  const names = [
    'KF_BUNDLED_EXTENSION_ROOT',
    'KF_CACHE_HOME',
    'KF_CONFIG_HOME',
    'KF_EXTENSION_PATH',
    'KF_HOME',
    'KF_INSTANCE_HOME',
    'KF_RUNTIME_DIR',
    'KF_SKILL_PATH',
    'KUNGFU_AS_VARIANT',
    'KUNGFU_DIR',
    'KUNGFU_INSTALL_SOURCE',
    'KUNGFU_NODE_VARIANT_ENTRY',
    'KUNGFU_UPGRADE_MANIFEST',
    'NODE_OPTIONS',
    'NODE_PATH',
    'PYTHONHOME',
    'PYTHONPATH',
    'Kf_Extension_Path',
    'PythonPath',
  ];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = hostile;
  try {
    const inspected = [];
    const report = qualifyProductCacheHome({
      app,
      verifySignature: false,
      runCommand: successfulRunCommand(app, {
        inspectEnv: (env) => inspected.push(env),
      }),
    });
    assert.equal(report.qualified, true);
    assert.ok(inspected.length >= 5);
    for (const env of inspected) {
      assert.equal(env.PYTHONPATH, '');
      assert.equal(env.PYTHONHOME, '');
      assert.equal(env.NODE_PATH, '');
      assert.equal(env.NODE_OPTIONS, '');
      assert.notEqual(env.KUNGFU_DIR, hostile);
      assert.notEqual(env.KF_BUNDLED_EXTENSION_ROOT, hostile);
      assert.notEqual(env.KF_EXTENSION_PATH, hostile);
      assert.notEqual(env.KF_SKILL_PATH, hostile);
      assert.ok(
        env.KUNGFU_AS_VARIANT === undefined || env.KUNGFU_AS_VARIANT === 'node',
      );
      assert.notEqual(env.KUNGFU_NODE_VARIANT_ENTRY, hostile);
      assert.notEqual(env.KF_HOME, hostile);
      assert.notEqual(env.KF_CACHE_HOME, hostile);
      assert.notEqual(env.KF_CONFIG_HOME, hostile);
      assert.notEqual(env.KF_INSTANCE_HOME, hostile);
      assert.notEqual(env.KF_RUNTIME_DIR, hostile);
      assert.notEqual(env.KUNGFU_UPGRADE_MANIFEST, hostile);
      assert.equal(env.Kf_Extension_Path, undefined);
      assert.equal(env.PythonPath, undefined);
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
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
