#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// kungfu pre-commit logic — all in Node so it runs identically on macOS, Linux
// and Windows. The .githooks/pre-commit shim is a tiny POSIX sh file that only
// execs this (git needs a launchable hook and sh is the one interpreter it ships
// everywhere, incl. Git-for-Windows bundled bash); no checks live in the shim.
//
// Pre-commit is intentionally read-only: it runs the fast staged gate and never
// formats or re-stages files. Use `./kungfu-code fix:staged` or
// `./kungfu-code fix` for explicit source rewriting.
//
// Bypass everything with `git commit -n`.
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';

function git(args, opts = {}) {
  return spawnSync('git', args, { encoding: 'utf8', ...opts });
}

const ROOT = git(['rev-parse', '--show-toplevel']).stdout?.trim();
if (!ROOT) process.exit(0);

function warn(msg) {
  process.stderr.write(`[kungfu pre-commit] ${msg}\n`);
}

const check = spawnSync(
  process.execPath,
  [path.join(ROOT, 'scripts', 'check.mjs'), '--staged'],
  {
    cwd: ROOT,
    stdio: 'inherit',
  },
);

if (check.error) {
  warn(
    `check could not be spawned (${check.error.code || check.error.message}); skipped staged gate`,
  );
  process.exit(0);
}

if (check.status !== 0) {
  process.exit(1);
}
process.exit(0);
