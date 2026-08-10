#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = path.join(ROOT, 'framework/core');
const isWin = process.platform === 'win32';
const shifu = path.join(ROOT, isWin ? 'shifu.cmd' : 'shifu');
const readonlyPytest = process.env.KUNGFU_READONLY_PYTEST;
const standaloneEnv = { ...process.env };
standaloneEnv.NODE_TEST_CONTEXT = undefined;
standaloneEnv.NODE_TEST_WORKER_ID = undefined;
const steps = [
  {
    command: process.execPath,
    args: ['scripts/check-agent-work-state-contract.test.mjs'],
    cwd: ROOT,
    env: standaloneEnv,
  },
  {
    command: readonlyPytest || shifu,
    args: readonlyPytest
      ? [
          '-q',
          '-p',
          'no:cacheprovider',
          path.join(CORE, 'tests/python/test_agent_work_state_contract.py'),
        ]
      : [
          'exec',
          'uv',
          'run',
          '--project',
          CORE,
          '--frozen',
          'pytest',
          '-q',
          path.join(CORE, 'tests/python/test_agent_work_state_contract.py'),
        ],
    cwd: CORE,
    env: {
      ...standaloneEnv,
      PYTHONPATH: [path.join(CORE, 'src/python'), process.env.PYTHONPATH]
        .filter(Boolean)
        .join(path.delimiter),
    },
    shell: isWin,
  },
];

for (const step of steps) {
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd,
    env: step.env ?? process.env,
    stdio: 'inherit',
    shell: step.shell ?? isWin,
  });
  if (result.status !== 0) {
    if (result.error) console.error(result.error.message);
    process.exit(result.status ?? 1);
  }
}
