// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolveTuiRuntimeDir } from './terminal-lifecycle.js';

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
