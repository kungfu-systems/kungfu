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
const GENERATED_EVIDENCE_ROOTS = ['.kungfu/', '.xinfa/'];
// Repo-relative roots of the mypy-checked surface. Mirrors `files` under
// [tool.mypy] in framework/core/pyproject.toml, which stays the single source of
// truth for what gets checked; this list only decides whether a changed file
// makes the type baseline worth running at all.
const TYPED_PYTHON_ROOTS = [
  'framework/core/src/python/',
  'framework/sdk/python/kungfu_sdk/',
  'framework/api/src/capability/guest-harness/',
  'extensions/mission-control/mission-control-actions/',
];
const isWin = process.platform === 'win32';

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

function commandAvailable(command) {
  return (
    spawnSync(isWin ? 'where' : 'which', [command], {
      stdio: 'ignore',
      shell: isWin,
    }).status === 0
  );
}

function commandProbe(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

export function sourcePythonCommand(args, available = commandAvailable) {
  if (available('ruff')) return { command: 'ruff', args };
  if (available('uvx')) return { command: 'uvx', args: ['ruff', ...args] };
  if (available('uv')) {
    return { command: 'uv', args: ['tool', 'run', 'ruff', ...args] };
  }
  throw new Error('source acceptance requires ruff, uvx, or uv');
}

export function sourceMypyCommand(
  args,
  available = commandAvailable,
  probe = commandProbe,
) {
  if (available('mypy')) {
    const result = probe('mypy', ['--version']);
    const version = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status === 0 && /(?:^|\n)mypy 1\.20\.2(?:\s|$)/.test(version)) {
      return { command: 'mypy', args };
    }
  }
  if (available('uvx')) {
    return {
      command: 'uvx',
      args: ['--from', 'mypy==1.20.2', 'mypy', ...args],
    };
  }
  if (available('uv')) {
    return {
      command: 'uv',
      args: ['tool', 'run', '--from', 'mypy==1.20.2', 'mypy', ...args],
    };
  }
  throw new Error('source acceptance requires mypy 1.20.2, uvx, or uv');
}

export function sourceClangFormatCommand(
  args,
  available = commandAvailable,
  probe = commandProbe,
) {
  if (available('clang-format')) {
    const result = probe('clang-format', ['--version']);
    const version = `${result.stdout || ''}${result.stderr || ''}`;
    if (
      result.status === 0 &&
      /clang-format version 20\.1\.8(?:\s|$)/u.test(version)
    )
      return { command: 'clang-format', args };
  }
  if (available('uvx'))
    return { command: 'uvx', args: ['clang-format@20.1.8', ...args] };
  if (available('uv')) {
    return {
      command: 'uv',
      args: [
        'tool',
        'run',
        '--from',
        'clang-format==20.1.8',
        'clang-format',
        ...args,
      ],
    };
  }
  throw new Error('source acceptance requires clang-format 20.1.8, uvx, or uv');
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
    [
      'Shifu Documentation Protocol',
      'scripts/check-shifu-documentation-contract.mjs',
    ],
    ['Shifu Gate contract', 'scripts/check-shifu-gate-contract.mjs'],
    ['Kungfu Gate catalog', 'scripts/check-kungfu-gate-catalog.mjs'],
    ['Xinfa standalone boundary', 'xinfa/tooling/check-boundary.mjs'],
    ['carrier/action envelope', 'scripts/check-carrier-action-envelope.mjs'],
    ['runtime greenfield', 'scripts/check-runtime-greenfield.mjs'],
    ['schema authority', 'scripts/check-schema-authority.mjs'],
    [
      'core architecture contract',
      'framework/core/architecture/check-layers.mjs',
    ],
    [
      'core architecture negative fixtures',
      'framework/core/architecture/check-layers.mjs',
      '--self-test',
    ],
    [
      'core architecture query and health contract',
      'framework/core/architecture/query-health.mjs',
    ],
    [
      'core architecture query negative and navigation fixtures',
      'framework/core/architecture/query-health.mjs',
      '--self-test',
    ],
    [
      'core build capability contract',
      'framework/core/architecture/check-build-capabilities.mjs',
    ],
    [
      'core build capability negative fixtures',
      'framework/core/architecture/check-build-capabilities.mjs',
      '--self-test',
    ],
    [
      'core affected-native negative fixtures',
      'scripts/run-core-affected-native.mjs',
      '--self-test',
    ],
    [
      'journal authority boundary',
      'scripts/check-journal-authority-boundary.mjs',
    ],
    ['live runtime terminology', 'scripts/check-live-runtime-terminology.mjs'],
    ['runtime activation contract', 'scripts/check-runtime-contract.mjs'],
    ['runtime upgrade contract', 'scripts/check-upgrade-contract.mjs'],
    [
      'product upgrade qualification',
      'scripts/check-upgrade-qualification.mjs',
    ],
    ['agent session contract', 'scripts/check-agent-session-contract.mjs'],
    ['Project Cut contract', 'scripts/check-project-cut-contract.mjs'],
    [
      'Project Cut settlement contract',
      'scripts/check-project-cut-settlement.mjs',
    ],
    ['Project Cut history contract', 'scripts/check-project-cut-history.mjs'],
    [
      'workspace continuation contract',
      'scripts/check-workspace-continuation.mjs',
    ],
    [
      'Episode Admission contract',
      'scripts/check-episode-admission-contract.mjs',
    ],
    [
      'durability production-candidate admission',
      'scripts/check-durability-production-candidate.mjs',
    ],
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
        'scripts/run-shifu-lifecycle.test.mjs',
        'scripts/check-typescript-files.test.mjs',
        'scripts/source-acceptance.test.mjs',
        'scripts/check-shifu-entry-contract.test.mjs',
        'scripts/check-shifu-cache-contract.test.mjs',
        'scripts/check-health-diagnostics-contract.test.mjs',
        'scripts/shifu-cache-runtime.test.mjs',
        'scripts/shifu-conan-publish.test.mjs',
        'scripts/shifu-uv-cache-adapter.test.mjs',
        'scripts/shifu-gate-runtime.test.mjs',
        'scripts/shifu-gate-executor.test.mjs',
        'scripts/shifu-documentation-runtime.test.mjs',
        'scripts/shifu-documentation-surfaces.test.mjs',
        'scripts/documentation-product-pack.test.mjs',
        'scripts/shifu-documentation-consumers.test.mjs',
        'scripts/shifu-documentation-qualification.test.mjs',
        'scripts/kungfu-xinfa-consumer.test.mjs',
        'scripts/check-kungfu-gate-catalog.test.mjs',
        'scripts/verify-kungfu-release-admission.test.mjs',
        'xinfa/tooling/check-boundary.test.mjs',
        'scripts/check-schema-authority.test.mjs',
        'scripts/check-runtime-contract.test.mjs',
        'scripts/check-upgrade-contract.test.mjs',
        'scripts/probe-cpp-cmake-contract.test.mjs',
        'scripts/check-upgrade-qualification.test.mjs',
        'scripts/upgrade-publication-admission.test.mjs',
        'scripts/check-agent-session-contract.test.mjs',
        'scripts/check-project-cut-contract.test.mjs',
        'scripts/check-git-episode-provider.test.mjs',
        'scripts/check-project-cut-settlement.test.mjs',
        'scripts/check-project-cut-history.test.mjs',
        'scripts/check-workspace-continuation.test.mjs',
        'scripts/check-episode-admission-contract.test.mjs',
        'framework/agent-session/tests/capsule-host.test.mjs',
        'framework/agent-session/tests/peer-transport.test.mjs',
        'framework/agent-session/tests/runtime-port.test.mjs',
        'framework/agent-session/tests/provider-adapters.test.mjs',
        'framework/agent-session/tests/interaction-port.test.mjs',
        'framework/agent-session/tests/codex-app-server-contract.test.mjs',
        'framework/agent-session/tests/codex-app-server-interaction.test.mjs',
        'framework/agent-session/tests/codex-app-server-recovery.test.mjs',
        'framework/agent-session/tests/codex-app-server-runtime.test.mjs',
        'framework/agent-session/tests/codex-app-server-product.test.mjs',
        'framework/agent-session/tests/product-surface.test.mjs',
        'framework/agent-session/tests/product-detached-host.test.mjs',
        'extensions/terminal/tests/agent-session-snapshot.test.ts',
        'framework/core/tests/qualification/runtime-activation/run.test.mjs',
        'framework/core/tests/qualification/durability/run.test.mjs',
        'framework/core/tests/qualification/durability/powercut_plan.test.mjs',
        'framework/core/tests/qualification/durability/fault_campaign.test.mjs',
        'framework/core/tests/qualification/durability/candidate_evidence.test.mjs',
        'framework/core/tests/qualification/durability/retained_evidence.test.mjs',
        'framework/core/tests/qualification/durability/institutional_evidence.test.mjs',
        'framework/core/tests/qualification/durability/product_contract.test.mjs',
        'framework/core/tests/qualification/durability/slo_evidence.test.mjs',
        'framework/core/tests/qualification/durability/offhost_evidence.test.mjs',
        'framework/core/tests/qualification/durability/clean_restart_evidence.test.mjs',
        'framework/core/tests/qualification/durability/production_candidate_admission.test.mjs',
        'scripts/run-durability-powercut-qemu.test.mjs',
        'scripts/prepare-durability-powercut-qemu.test.mjs',
        'scripts/run-durability-fault-campaign.test.mjs',
        'scripts/run-durability-institutional-qemu.test.mjs',
        'scripts/run-durability-slo.test.mjs',
        'scripts/run-durability-offhost-restore.test.mjs',
        'scripts/run-durability-clean-host-restart.test.mjs',
      ],
    },
    {
      label: 'agent work state contract and CLI parity',
      command: process.execPath,
      args: ['scripts/run-agent-work-state-tests.mjs'],
    },
    {
      label: 'runtime upgrade control-plane tests',
      command: process.execPath,
      args: ['scripts/run-runtime-upgrade-tests.mjs'],
    },
    {
      label: 'desktop update adapter tests',
      command: process.execPath,
      args: ['scripts/run-desktop-update-tests.mjs'],
    },
    {
      label: 'tooling type check',
      command: process.execPath,
      args: ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.tools.json'],
    },
  ];

  const web = files.filter(
    (file) =>
      WEB.test(file) &&
      !GENERATED_EVIDENCE_ROOTS.some((root) => file.startsWith(root)),
  );
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

  const guiTypeScript = files.filter(
    (file) => file.startsWith('framework/gui/src/') && /\.tsx?$/.test(file),
  );
  if (guiTypeScript.length) {
    plan.push({
      label: 'changed GUI TypeScript check',
      command: process.execPath,
      args: [
        'scripts/check-typescript-files.mjs',
        '--project',
        'framework/gui/tsconfig.json',
        ...guiTypeScript,
      ],
    });
  }

  const python = files.filter((file) => file.endsWith('.py'));
  if (python.length) {
    const format = sourcePythonCommand([
      'format',
      '--check',
      '--force-exclude',
      ...python,
    ]);
    const lint = sourcePythonCommand(['check', '--force-exclude', ...python]);
    plan.push(
      {
        label: 'changed Python format',
        ...format,
      },
      {
        label: 'changed Python lint',
        ...lint,
      },
    );
  }

  const typedPython = python.filter((file) =>
    TYPED_PYTHON_ROOTS.some((root) => file.startsWith(root)),
  );
  if (typedPython.length) {
    const mypy = sourceMypyCommand(['--config-file', 'pyproject.toml']);
    plan.push({
      label: 'Python type baseline',
      ...mypy,
      cwd: path.join(ROOT, 'framework/core'),
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
    const formatter = sourceClangFormatCommand([
      '-style=file',
      '--dry-run',
      '-Werror',
      ...cpp,
    ]);
    plan.push({
      label: 'changed C/C++ format',
      ...formatter,
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
