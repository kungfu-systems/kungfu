#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const kungfu = require('../lib/kungfu')();
const coreDir = path.resolve(__dirname, '..');
const fixtureDir = path.join(
  coreDir,
  'src',
  'libkungfu',
  'tests',
  'fixtures',
  'native_kfx_registry',
);
const expected = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, 'expected-roots.json'), 'utf8'),
);
const nativeAvailable = typeof kungfu.runStorageServiceOperation === 'function';
const nativeTest = {
  skip:
    nativeAvailable || process.env.KUNGFU_REQUIRE_NATIVE === '1'
      ? false
      : 'built native storage binding is unavailable',
};

test(
  'Node KFX semantic graph matches the Core golden roots',
  nativeTest,
  () => {
    const plan = kungfu.runStorageServiceOperation('kfx_runtime', '', {
      action: 'plan',
      request: {
        roots: [
          {
            kind: 'workspace',
            path: path.join(fixtureDir, 'semantic'),
          },
        ],
      },
    });

    assert.equal(plan.graphRoot, expected.semanticGraphRoot);
    assert.equal(plan.planRoot, expected.semanticPlanRoot);
    assert.equal(
      plan.hostContract.receiptDependencyRoot,
      expected.semanticHostReceiptDependencyRoot,
    );
  },
);

test(
  'Node KFX lifecycle plan and receipt match Core golden roots',
  nativeTest,
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-native-kfx-node-'));
    try {
      const sourceRoot = path.join(home, 'sources');
      fs.mkdirSync(sourceRoot);
      fs.cpSync(
        path.join(
          fixtureDir,
          'roots',
          'workspace',
          'example-suite',
          'members',
          'optional-view',
        ),
        path.join(sourceRoot, 'optional-view'),
        { recursive: true },
      );
      const runtimeDir = path.join(home, 'runtime');
      const request = {
        roots: [{ kind: 'user', path: sourceRoot }],
        runtimeTiers: { 'optional-view': 'verified-third-party' },
        packageKey: 'optional-view',
        operation: 'install',
      };
      const plan = kungfu.runStorageServiceOperation(
        'kfx_runtime',
        runtimeDir,
        { action: 'plan', request },
      );
      const pkg = plan.packages.find((item) => item.key === 'optional-view');
      const application = kungfu.runStorageServiceOperation(
        'kfx_runtime',
        runtimeDir,
        {
          action: 'apply',
          request: {
            ...request,
            expectedCutRoot: plan.cutRoot,
            expectedRevision: plan.revision,
            expectedRegistryRoot: plan.registryRoot,
            expectedGraphRoot: plan.graphRoot,
            expectedPlanRoot: plan.planRoot,
            expectedTrustRoot: pkg.trustRoot,
            expectedPackageRoot: pkg.packageRoot,
            actor: 'node-root-parity-test',
            systemTime: 100,
          },
        },
      );

      assert.equal(plan.registryRoot, expected.lifecycleRegistryRoot);
      assert.equal(plan.graphRoot, expected.lifecycleGraphRoot);
      assert.equal(plan.planRoot, expected.lifecyclePlanRoot);
      assert.equal(application.revision, 1);
      assert.match(application.cutRoot, /^sha256:[0-9a-f]{64}$/);
      assert.equal(
        application.receipt.schema,
        'kungfu.kfx.work-settlement-receipt/v1',
      );
      assert.equal(
        fs.existsSync(path.join(runtimeDir, 'kfx', 'registry-history.jsonl')),
        false,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  },
);
