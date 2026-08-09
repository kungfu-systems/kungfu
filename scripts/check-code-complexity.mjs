#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

/** Build-free entrypoint for the exact-root Python structure ratchet. */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function pythonCommand(platform = process.platform, env = process.env) {
  return (
    env.KUNGFU_PYTHON_STRUCTURE_PYTHON ||
    (platform === 'win32' ? 'python' : 'python3')
  );
}

export function checkerArgs(args = process.argv.slice(2)) {
  return [path.join(ROOT, 'scripts/check-python-structure.py'), ...args];
}

export function main(args = process.argv.slice(2)) {
  const result = spawnSync(pythonCommand(), checkerArgs(args), {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    process.stderr.write(
      `python-structure: unable to run checker: ${result.error.message}\n`,
    );
    return 2;
  }
  return result.status ?? 2;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  process.exit(main());
