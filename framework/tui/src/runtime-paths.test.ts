// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveTuiCliRuntime,
  resolveTuiProductPaths,
  resolveTuiRuntimeDir,
} from './terminal-lifecycle.js';

test('packaged TUI resolves from KUNGFU_DIR without npm package discovery', () => {
  let packageResolutionAttempted = false;
  const paths = resolveTuiProductPaths({
    env: { KUNGFU_DIR: '/product/Resources/kungfu' },
    resolveCorePackageJson: () => {
      packageResolutionAttempted = true;
      throw new Error('packaged TUI must not resolve development packages');
    },
  });
  assert.equal(packageResolutionAttempted, false);
  assert.deepEqual(paths, {
    coreDir: '/product/Resources',
    kungfuDir: '/product/Resources/kungfu',
    packagedBin: `/product/Resources/kungfu/${
      process.platform === 'win32' ? 'kungfu.exe' : 'kungfu'
    }`,
  });
});

test('TUI dev explicitly prefers the source CLI over a stale packaged build', () => {
  const packagedBin = '/checkout/framework/core/dist/kungfu/kungfu';
  assert.deepEqual(
    resolveTuiCliRuntime({
      env: { KUNGFU_TUI_SOURCE_CLI: '1' },
      packagedBin,
    }),
    { bin: 'uv', sourceCliFallback: true },
  );
  assert.deepEqual(
    resolveTuiCliRuntime({
      env: { KUNGFU_TUI_SOURCE_CLI: '1', KUNGFU_CLI_BIN: '/exact/kungfu' },
      packagedBin,
    }),
    { bin: '/exact/kungfu', sourceCliFallback: false },
  );
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
