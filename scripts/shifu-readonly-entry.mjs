#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function route(command, args) {
  if (command === 'core:architecture')
    return ['framework/core/architecture/query-health.mjs', args];
  if (command === 'core:architecture:health')
    return [
      'framework/core/architecture/query-health.mjs',
      ['--health', ...args],
    ];
  if (command === 'invariant:verify' && args.includes('--list'))
    return ['scripts/kungfu-invariant-discovery.mjs', args];
  if (command === 'maintainability:complexity')
    return ['scripts/code-complexity-budget.mjs', args];
  if (
    ['maintainability:amplification', 'maintainability:query'].includes(command)
  )
    return [
      'framework/maintainability/semantic-amplification.mjs',
      command === 'maintainability:query' ? ['--query', ...args] : args,
    ];
  return null;
}

const [command = '', ...args] = process.argv.slice(2);
const target = route(command, args);
if (!target) {
  process.stderr.write(`shifu: unsupported build-free route '${command}'\n`);
  process.exit(2);
}
const result = spawnSync(
  process.execPath,
  [path.join(ROOT, target[0]), ...target[1]],
  {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  },
);
if (result.error) {
  process.stderr.write(
    `shifu: build-free route failed: ${result.error.message}\n`,
  );
  process.exit(2);
}
process.exit(result.status ?? 2);

export { route };
