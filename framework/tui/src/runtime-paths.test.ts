// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveTuiRuntimePaths } from './runtime-paths.js';
import { resolveTuiRuntimeDir } from './terminal-lifecycle.js';

test('uses the packaged runtime without resolving the source core package', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-tui-product-'));
  try {
    const kungfuDir = path.join(root, 'runtime');
    const launcher = path.join(kungfuDir, 'kungfu');
    fs.mkdirSync(kungfuDir, { recursive: true });
    fs.writeFileSync(launcher, '');
    let sourceResolutionCalls = 0;
    const paths = resolveTuiRuntimePaths({
      env: {
        HOME: root,
        KUNGFU_DIR: kungfuDir,
        KF_CONFIG_HOME: path.join(root, 'config'),
        KF_RUNTIME_DIR: path.join(root, 'state'),
      },
      cwd: root,
      platform: 'linux',
      resolveCorePackagePath: () => {
        sourceResolutionCalls += 1;
        throw new Error('the installed product has no source npm package');
      },
    });

    assert.equal(sourceResolutionCalls, 0);
    assert.equal(paths.coreDir, root);
    assert.equal(paths.bin, launcher);
    assert.equal(paths.sourceCliFallback, false);
    assert.equal(paths.runtimeDir, path.join(root, 'state'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('preserves CLI runtime-root precedence without booting Python', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-tui-runtime-'));
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    const contract = path.join(root, 'contract.json');
    fs.writeFileSync(
      contract,
      JSON.stringify({
        resolution: {
          runtimeHomeEnv: 'KF_HOME',
          defaultRuntimeHome: { default: '~/.config/kungfu/home' },
          environmentFallbacks: {},
        },
      }),
    );
    assert.equal(
      resolveTuiRuntimeDir({
        env: { HOME: root, KF_RUNTIME_DIR: path.join(root, 'exact-runtime') },
        cwd: workspace,
        contractPath: contract,
      }),
      path.join(root, 'exact-runtime'),
    );
    assert.equal(
      resolveTuiRuntimeDir({
        env: { HOME: root },
        cwd: path.join(workspace, 'nested'),
        contractPath: contract,
      }),
      path.join(workspace, '.kungfu', 'runtime'),
    );
    assert.equal(
      resolveTuiRuntimeDir({
        env: { HOME: root, KF_HOME: path.join(root, 'explicit-home') },
        cwd: workspace,
        contractPath: contract,
      }),
      path.join(root, 'explicit-home', 'runtime'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
