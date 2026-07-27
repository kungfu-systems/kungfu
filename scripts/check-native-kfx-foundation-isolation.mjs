#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';

const baseline =
  process.env.KUNGFU_NATIVE_KFX_BASE_REF ??
  'd1d3581400e86ead173901ffdbd50a19b86bd012';
const qualificationLabMerge = '1f7cfe58cc7699ac27106241430d77f6938eadcd';
const protectedBranch = 'feature/agent-work-lab-kfx-suite';
const protectedPaths = [
  'framework/core/src/python/kungfu/qualification_lab.py',
  'framework/core/src/python/kungfu/cli/commands/qualification_lab.py',
  'framework/api/src/capability/qualification-lab.ts',
  'framework/gui/src/renderer/src/qualification-lab.tsx',
  'framework/tui/src/qualification-lab-view.tsx',
  'framework/tui/src/main.tsx',
];

function git(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

const branch = git(['branch', '--show-current']);
if (branch === protectedBranch) {
  throw new Error(
    `[native-kfx-isolation] refusing protected Qualification Lab branch ${branch}`,
  );
}

try {
  git(['merge-base', '--is-ancestor', qualificationLabMerge, 'HEAD']);
} catch {
  throw new Error(
    `[native-kfx-isolation] HEAD does not descend from merged Qualification Lab PR #1585 commit ${qualificationLabMerge}`,
  );
}

const changed = new Set(
  git(['diff', '--name-only', baseline, '--']).split('\n').filter(Boolean),
);
const violations = protectedPaths.filter((path) => changed.has(path));
if (violations.length > 0) {
  throw new Error(
    `[native-kfx-isolation] protected Qualification Lab paths changed:\n${violations.join('\n')}`,
  );
}

process.stdout.write(
  `[native-kfx-isolation] PASS branch=${branch} baseline=${baseline} protected_changes=0 pr=1585 merge=${qualificationLabMerge}\n`,
);
