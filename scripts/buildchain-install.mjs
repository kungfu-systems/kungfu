#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LIFECYCLE_DISPATCHER = path.join(
  ROOT,
  'scripts',
  'run-shifu-lifecycle.mjs',
);

/** @typedef {{command: string, args: string[], cwd?: string}} Command */

/** @param {NodeJS.ProcessEnv} env */
export function installPlan(env = process.env) {
  if (env.BUILDCHAIN_CHECK_MODE !== 'source') {
    return [
      {
        command: process.execPath,
        args: [LIFECYCLE_DISPATCHER, 'cache-apply', 'doctor'],
      },
      {
        command: process.execPath,
        args: [
          LIFECYCLE_DISPATCHER,
          'cache-apply',
          'install',
          '--frozen-lockfile',
          '--no-optional',
        ],
      },
    ];
  }

  if (
    env.CI === 'true' &&
    (env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.RUNNER_OS !== 'Linux')
  ) {
    throw new Error(
      'source acceptance is restricted to GitHub-hosted Linux runners',
    );
  }

  const tools = path.join(
    env.RUNNER_TEMP || os.tmpdir(),
    'kungfu-source-acceptance-tools',
  );
  const python = path.join(tools, 'bin', 'python');
  return [
    {
      command: 'corepack',
      args: ['pnpm@11.7.0', 'install', '--frozen-lockfile', '--ignore-scripts'],
    },
    { command: 'python3', args: ['-m', 'venv', tools] },
    {
      command: python,
      args: [
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '--only-binary=:all:',
        'ruff==0.15.20',
        'mypy==1.20.2',
        'clang-format==20.1.8',
      ],
    },
  ];
}

/** @param {Command} step */
function run(step) {
  console.log(`[buildchain-install] $ ${step.command} ${step.args.join(' ')}`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd || ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${step.command} failed: ${result.error?.message || result.status}`,
    );
  }
}

function main() {
  const plan = installPlan();
  for (const step of plan) run(step);
  if (process.env.BUILDCHAIN_CHECK_MODE === 'source') {
    const tools = path.dirname(plan.at(-1)?.command || '');
    if (!process.env.GITHUB_PATH) {
      throw new Error('GITHUB_PATH is required for source acceptance');
    }
    fs.appendFileSync(process.env.GITHUB_PATH, `${tools}\n`);
    console.log(`[buildchain-install] source tools ready: ${tools}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[buildchain-install] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
