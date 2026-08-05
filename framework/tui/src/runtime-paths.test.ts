// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  resolveTuiAgentSessionPaths,
  resolveTuiCliRuntime,
  resolveTuiProductPaths,
  resolveTuiRuntimeDir,
} from './terminal-lifecycle.js';

test('embedded TUI resolves bundled Agent Session files from its admitted entry', () => {
  const entry = path.resolve('/checkout/framework/tui/dist/tui.mjs');
  const bundleDir = path.dirname(entry);
  const paths = resolveTuiAgentSessionPaths({
    env: { KUNGFU_TUI_ENTRY: entry },
    modulePath: '/native/runtime/tui.mjs',
    exists: (candidate) =>
      candidate === entry ||
      candidate === path.join(bundleDir, 'agent-session-worker.mjs') ||
      candidate === path.join(bundleDir, 'mock-agent.mjs'),
  });

  assert.deepEqual(paths, {
    packageRoot: path.resolve('/checkout/framework/agent-session'),
    workerPath: path.join(bundleDir, 'agent-session-worker.mjs'),
    mockPath: path.join(bundleDir, 'mock-agent.mjs'),
  });
});

test('TUI retains source Agent Session fallbacks without an admitted entry', () => {
  assert.deepEqual(
    resolveTuiAgentSessionPaths({
      env: {},
      modulePath: '/checkout/framework/tui/src/main.tsx',
      exists: () => false,
    }),
    {
      packageRoot: path.resolve('/checkout/framework/agent-session'),
      workerPath: path.resolve(
        '/checkout/framework/agent-session/src/product-worker.mjs',
      ),
      mockPath: path.resolve(
        '/checkout/framework/agent-session/src/mock-provider.mjs',
      ),
    },
  );
});

test('embedded libnode uses its admitted argv entry when env is not projected', () => {
  const entry = path.resolve('/checkout/framework/tui/dist/tui.mjs');
  const bundleDir = path.dirname(entry);
  assert.deepEqual(
    resolveTuiAgentSessionPaths({
      env: {},
      argvEntry: entry,
      modulePath: '/native/runtime/tui.mjs',
      exists: (candidate) =>
        candidate === entry ||
        candidate === path.join(bundleDir, 'agent-session-worker.mjs') ||
        candidate === path.join(bundleDir, 'mock-agent.mjs'),
    }),
    {
      packageRoot: path.resolve('/checkout/framework/agent-session'),
      workerPath: path.join(bundleDir, 'agent-session-worker.mjs'),
      mockPath: path.join(bundleDir, 'mock-agent.mjs'),
    },
  );
});

test('embedded libnode derives its source bundle from Product extensions', () => {
  const entry = path.resolve('/checkout/framework/tui/dist/tui.mjs');
  const bundleDir = path.dirname(entry);
  assert.deepEqual(
    resolveTuiAgentSessionPaths({
      env: { KF_BUNDLED_EXTENSION_ROOT: '/checkout/product/extensions' },
      argvEntry: '/native/runtime/tui.mjs',
      modulePath: '/native/runtime/tui.mjs',
      exists: (candidate) =>
        candidate === entry ||
        candidate === path.join(bundleDir, 'agent-session-worker.mjs') ||
        candidate === path.join(bundleDir, 'mock-agent.mjs'),
    }),
    {
      packageRoot: path.resolve('/checkout/framework/agent-session'),
      workerPath: path.join(bundleDir, 'agent-session-worker.mjs'),
      mockPath: path.join(bundleDir, 'mock-agent.mjs'),
    },
  );
});

test('embedded libnode derives its packaged bundle from Product extensions', () => {
  const entry = path.resolve('/product/Resources/tui/tui.mjs');
  const bundleDir = path.dirname(entry);
  assert.deepEqual(
    resolveTuiAgentSessionPaths({
      env: { KF_BUNDLED_EXTENSION_ROOT: '/product/Resources/extensions' },
      modulePath: '/product/Resources/kungfu/tui.mjs',
      exists: (candidate) =>
        candidate === entry ||
        candidate === path.join(bundleDir, 'agent-session-worker.mjs') ||
        candidate === path.join(bundleDir, 'mock-agent.mjs'),
    }),
    {
      packageRoot: path.resolve('/product/agent-session'),
      workerPath: path.join(bundleDir, 'agent-session-worker.mjs'),
      mockPath: path.join(bundleDir, 'mock-agent.mjs'),
    },
  );
});

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
    {
      bin: 'uv',
      sourceCliFallback: true,
      runtimeSurface: 'source-checkout',
      selectionReason: 'explicit-source-environment',
    },
  );
  assert.deepEqual(
    resolveTuiCliRuntime({
      env: { KUNGFU_TUI_SOURCE_CLI: '1', KUNGFU_CLI_BIN: '/exact/kungfu' },
      packagedBin,
    }),
    {
      bin: '/exact/kungfu',
      sourceCliFallback: false,
      runtimeSurface: 'installed-product',
      selectionReason: 'explicit-installed-command',
    },
  );
});

test('TUI fails closed instead of silently switching to source', () => {
  assert.throws(
    () =>
      resolveTuiCliRuntime({
        env: {},
        packagedBin: '/definitely/missing/kungfu',
      }),
    /KUNGFU_TUI_SOURCE_CLI=1/u,
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
