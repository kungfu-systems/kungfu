#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { devMergeBaseCandidates } from './candidate-timeline-events.cjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

function run(label, command, args, env = process.env) {
  process.stdout.write(`[native-admission] ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function git(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || `git ${args.join(' ')} exited with failure`,
    );
  }
  return result.stdout.trim();
}

function checkQualificationLabIsolation() {
  const baseline =
    process.env.KUNGFU_NATIVE_KFX_BASE_REF ??
    git(['merge-base', 'HEAD', devMergeBaseCandidates()[0]]);
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
  const branch = git(['branch', '--show-current']);
  if (branch === protectedBranch) {
    throw new Error(`refusing protected Qualification Lab branch ${branch}`);
  }
  git(['merge-base', '--is-ancestor', qualificationLabMerge, 'HEAD']);
  const changed = new Set(
    git(['diff', '--name-only', baseline, '--']).split('\n').filter(Boolean),
  );
  const violations = protectedPaths.filter((item) => changed.has(item));
  if (violations.length > 0) {
    throw new Error(
      `protected Qualification Lab paths changed:\n${violations.join('\n')}`,
    );
  }
  process.stdout.write(
    `[native-kfx-isolation] PASS branch=${branch} baseline=${baseline} protected_changes=0 pr=1585 merge=${qualificationLabMerge}\n`,
  );
}

run('Core ABI, contract, and admission fixtures', 'ctest', [
  '--test-dir',
  path.join(root, 'framework/core/build'),
  '--build-config',
  'Release',
  '--output-on-failure',
  '--tests-regex',
  '^(kungfu_api_contract_tests|kungfu_native_kfx_contract_tests)$',
]);

const pythonPath = [
  path.join(root, 'framework/core/build/Release'),
  path.join(root, 'framework/core/src/python'),
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);

run(
  'Python binding and ActionEnvelope qualification',
  'uv',
  [
    'run',
    '--project',
    path.join(root, 'framework/core'),
    '--frozen',
    'pytest',
    path.join(root, 'framework/core/tests/python/test_native_kfx_contract.py'),
    path.join(root, 'framework/core/tests/python/test_action_envelope.py'),
  ],
  {
    ...process.env,
    KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
    PYTHONPATH: pythonPath,
  },
);

run('public API transport projection', 'pnpm', [
  '--filter',
  '@kungfu-tech/tui',
  'exec',
  'tsx',
  '--test',
  path.join(root, 'framework/api/tests/storage.test.ts'),
  path.join(root, 'framework/api/tests/kfx-host.test.ts'),
]);

run(
  'native Node binding root parity',
  'node',
  [
    '--test',
    path.join(
      root,
      'framework/core/tests/native-kfx-registry-node-binding.test.js',
    ),
  ],
  {
    ...process.env,
    KUNGFU_DIR: path.join(root, 'framework/core/build/Release'),
    KUNGFU_REQUIRE_NATIVE: '1',
  },
);

run('public API type contract', 'pnpm', [
  '--filter',
  '@kungfu-tech/api',
  'run',
  'build',
]);

run('KFX type contract', 'pnpm', [
  '--filter',
  '@kungfu-tech/kfx',
  'run',
  'build',
]);

run('schema authority gate', 'node', [
  path.join(root, 'scripts/check-schema-authority.mjs'),
]);

run('incubation passport gate', 'node', [
  path.join(root, 'scripts/check-incubation-passport.mjs'),
]);

run('incubation passport contract tests', 'node', [
  '--test',
  path.join(root, 'scripts/check-incubation-passport.test.mjs'),
]);

run('layered API encoding authority', 'node', [
  '--test',
  path.join(root, 'scripts/check-layered-api-encoding-boundary.test.mjs'),
]);

process.stdout.write(
  '[native-admission] Qualification Lab and PR #1585 isolation\n',
);
checkQualificationLabIsolation();
