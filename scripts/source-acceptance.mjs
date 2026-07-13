#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CPP = /\.(?:c|cc|cpp|cxx|h|hh|hpp|hxx)$/;
const WEB = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|jsonc|css)$/;

/** @typedef {{label: string, command: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv}} Command */

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`,
    );
  }
  return result.stdout.trim();
}

function gitMaybe(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

export function sourceMergeBase() {
  const candidates = [
    process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '',
    'origin/dev/v4/v4.0',
    'dev/v4/v4.0',
  ].filter(Boolean);
  for (const ref of candidates) {
    const sha = gitMaybe(['merge-base', ref, 'HEAD']);
    if (sha) return { ref, sha };
  }
  throw new Error(
    `cannot resolve source-acceptance merge base from: ${candidates.join(', ')}`,
  );
}

export function sourceChangedFiles() {
  const base = sourceMergeBase();
  /** @type {Set<string>} */
  const files = new Set();
  for (const args of [
    ['diff', '--name-only', '--diff-filter=ACM', `${base.sha}...HEAD`],
    ['diff', '--name-only', '--diff-filter=ACM'],
    ['diff', '--cached', '--name-only', '--diff-filter=ACM'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    for (const file of git(args).split('\n')) {
      const rel = file.trim();
      if (rel && fs.existsSync(path.join(ROOT, rel))) files.add(rel);
    }
  }
  console.log(
    `[source-acceptance] revision=${git(['rev-parse', 'HEAD'])} base=${base.ref}@${base.sha}`,
  );
  return [...files];
}

/** @param {string[]} files */
export function sourceAcceptancePlan(files) {
  const nodeChecks = [
    ['no Bash scripts', 'scripts/no-bash-guard.mjs'],
    ['Shifu entry contract', 'scripts/check-shifu-entry-contract.mjs'],
    ['Shifu cache contract', 'scripts/check-shifu-cache-contract.mjs'],
    ['carrier/action envelope', 'scripts/check-carrier-action-envelope.mjs'],
    ['runtime greenfield', 'scripts/check-runtime-greenfield.mjs'],
    ['schema authority', 'scripts/check-schema-authority.mjs'],
    [
      'journal authority boundary',
      'scripts/check-journal-authority-boundary.mjs',
    ],
    ['live runtime terminology', 'scripts/check-live-runtime-terminology.mjs'],
    ['Shifu version sync', 'scripts/sync-shifu-version.mjs', '--check'],
    ['documentation contracts', 'scripts/run-docs-source-check.mjs'],
  ];
  /** @type {Command[]} */
  const plan = [
    { label: 'diff hygiene', command: 'git', args: ['diff', '--check'] },
    ...nodeChecks.map(([label, ...args]) => ({
      label,
      command: process.execPath,
      args,
    })),
    {
      label: 'source-acceptance contract tests',
      command: process.execPath,
      args: [
        '--test',
        'scripts/buildchain-install.test.mjs',
        'scripts/source-acceptance.test.mjs',
        'scripts/check-shifu-entry-contract.test.mjs',
        'scripts/check-shifu-cache-contract.test.mjs',
        'scripts/shifu-cache-runtime.test.mjs',
        'scripts/shifu-conan-publish.test.mjs',
        'scripts/shifu-uv-cache-adapter.test.mjs',
        'scripts/check-schema-authority.test.mjs',
      ],
    },
    {
      label: 'tooling type check',
      command: process.execPath,
      args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.tools.json'],
    },
  ];

  const web = files.filter((file) => WEB.test(file));
  if (web.length) {
    plan.push({
      label: 'changed web source format and lint',
      command: process.execPath,
      args: [
        'node_modules/@biomejs/biome/bin/biome',
        'check',
        '--no-errors-on-unmatched',
        ...web,
      ],
    });
  }

  const python = files.filter((file) => file.endsWith('.py'));
  if (python.length) {
    plan.push(
      {
        label: 'changed Python format',
        command: 'ruff',
        args: ['format', '--check', '--force-exclude', ...python],
      },
      {
        label: 'changed Python lint',
        command: 'ruff',
        args: ['check', '--force-exclude', ...python],
      },
    );
  }

  const typedPython = python.filter((file) =>
    file.startsWith('framework/core/src/python/'),
  );
  if (typedPython.length) {
    plan.push({
      label: 'Python type baseline',
      command: 'mypy',
      args: [
        '--config-file',
        'framework/core/pyproject.toml',
        'framework/core/src/python/kungfu',
      ],
      env: {
        ...process.env,
        MYPY_CACHE_DIR: path.join(
          process.env.RUNNER_TEMP || '/tmp',
          'kungfu-source-mypy',
        ),
      },
    });
  }

  const cpp = files.filter((file) => CPP.test(file));
  if (cpp.length) {
    plan.push({
      label: 'changed C/C++ format',
      command: 'clang-format',
      args: ['-style=file', '--dry-run', '-Werror', ...cpp],
    });
  }
  return plan;
}

/** @param {Command} step */
function run(step) {
  console.log(`\n[source-acceptance] ${step.label}`);
  console.log(`[source-acceptance] $ ${step.command} ${step.args.join(' ')}`);
  const result = spawnSync(step.command, step.args, {
    cwd: step.cwd || ROOT,
    env: step.env || process.env,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${step.label} failed: ${result.error?.message || result.status}`,
    );
  }
}

function main() {
  const files = sourceChangedFiles();
  console.log(`[source-acceptance] changed files: ${files.length}`);
  for (const step of sourceAcceptancePlan(files)) run(step);
  console.log('\n[source-acceptance] build-free source gate passed');
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[source-acceptance] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}
