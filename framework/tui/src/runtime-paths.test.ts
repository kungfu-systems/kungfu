// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveTuiProductPaths } from './product-paths.js';
import { resolveTuiRuntimeDir } from './terminal-lifecycle.js';

test('installed runtime root is authoritative without a workspace package graph', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-tui-product-'));
  try {
    const runtime = path.join(root, 'runtime');
    const bin = path.join(
      runtime,
      process.platform === 'win32' ? 'kungfu.exe' : 'kungfu',
    );
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(bin, 'installed runtime\n');
    const paths = resolveTuiProductPaths({
      env: { KUNGFU_DIR: runtime },
      resolveCorePackage: () => {
        throw new Error('workspace package graph must not be consulted');
      },
    });
    assert.deepEqual(paths, {
      coreDir: '',
      kungfuDir: runtime,
      bin,
      sourceCliFallback: false,
    });
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
