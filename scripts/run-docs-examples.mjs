#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readContract } from './check-docs.mjs';
import { cmdCommand } from './run-shifu-lifecycle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

try {
  const contract = readContract(ROOT);
  for (const example of contract.executableExamples || []) {
    const [command, ...args] = example.command;
    const windowsShifu = process.platform === 'win32' && command === './shifu';
    const result = spawnSync(
      windowsShifu ? cmdCommand(path.join(ROOT, 'shifu.cmd'), args) : command,
      windowsShifu ? [] : args,
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: example.timeoutMs,
        shell: windowsShifu
          ? process.env.ComSpec || process.env.COMSPEC || 'cmd.exe'
          : false,
        env: { ...process.env, NO_COLOR: '1', SHIFU_NATIVE: '0' },
      },
    );
    if (result.error)
      throw new Error(`${example.id} could not run: ${result.error.message}`);
    if (result.status !== 0)
      throw new Error(
        `${example.id} exited ${result.status ?? result.signal}: ${(result.stderr || '').trim()}`,
      );
    if (
      example.stdoutPattern &&
      !new RegExp(example.stdoutPattern).test(result.stdout || '')
    )
      throw new Error(
        `${example.id} stdout did not match its contract: ${JSON.stringify((result.stdout || '').slice(0, 200))}`,
      );
    console.log(`[docs:examples] passed ${example.id}`);
  }
  console.log('[docs:examples] all declared examples passed');
} catch (error) {
  console.error(
    `[docs:examples] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
