#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const READONLY_SOURCE_COMMANDS = [
  'kfd status',
  'kfd query',
  'kfd check',
  'kfd:query',
  'kfd:support-matrix:check',
  'core:architecture',
  'core:architecture:health',
  'invariant:verify --list',
  'maintainability:complexity',
  'maintainability:function-risk',
  'maintainability:python-structure',
  'maintainability:amplification',
  'maintainability:query',
  'work-design:preflight',
  'work-design:feedback',
];

function route(command, args) {
  if (command === 'kfd') {
    const [operation = '', ...rest] = args;
    if (!['status', 'query', 'check'].includes(operation)) return null;
    return [
      'scripts/kfd-support-matrix.mjs',
      [`--source-${operation}`, ...rest],
    ];
  }
  if (command === 'kfd:query')
    return ['scripts/kfd-support-matrix.mjs', ['--source-query', ...args]];
  if (command === 'kfd:support-matrix:check')
    return ['scripts/kfd-support-matrix.mjs', ['--source-check', ...args]];
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
  if (command === 'maintainability:function-risk')
    return ['framework/maintainability/function-risk.mjs', args];
  if (command === 'maintainability:python-structure')
    return ['scripts/check-code-complexity.mjs', args];
  if (
    ['maintainability:amplification', 'maintainability:query'].includes(command)
  )
    return [
      'framework/maintainability/semantic-amplification.mjs',
      command === 'maintainability:query' ? ['--query', ...args] : args,
    ];
  if (command === 'work-design:preflight')
    return [
      'framework/work-design-preflight/tooling/work-design-preflight.mjs',
      args,
    ];
  if (command === 'work-design:feedback')
    return [
      'framework/work-design-policy-replay/tooling/check-work-design-policy-replay.mjs',
      ['feedback', ...args],
    ];
  return null;
}

function main() {
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
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();

export { READONLY_SOURCE_COMMANDS, route };
