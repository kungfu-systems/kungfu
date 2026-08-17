#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tuiRoot = path.join(root, 'framework', 'tui');
const isWin = process.platform === 'win32';
const agentWorkLabOnly = process.argv.includes('--agent-work-lab');
const logPrefix = agentWorkLabOnly ? '[agent-work-lab]' : '[kfx-profile-suite]';

function run(label, command, args, env = process.env) {
  process.stdout.write(`${logPrefix} ${label}\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: isWin,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function assertNoLegacyProductIdentity() {
  const roots = ['framework', 'extensions', 'product', 'scripts', 'docs'];
  const ignored = new Set([
    'docs/development/versioning.md',
    'framework/maintainability/code-complexity-baseline.json',
    'scripts/run-kfx-profile-suite-tests.mjs',
  ]);
  const ignoredPrefixes = ['docs/qualification/evidence/'];
  const legacyPatterns = [
    /Agent Qualification Lab/u,
    /qualification-lab/u,
    /qualification_lab/u,
    /\bQualificationLab\b/u,
    /\bqualificationLab\b/u,
  ];
  const violations = [];
  const listed = spawnSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...roots],
    { cwd: root, encoding: 'utf8' },
  );
  if (listed.error) throw listed.error;
  if (listed.status !== 0) process.exit(listed.status ?? 1);
  for (const relativePath of listed.stdout.split('\n').filter(Boolean)) {
    if (
      ignored.has(relativePath) ||
      ignoredPrefixes.some((prefix) => relativePath.startsWith(prefix))
    ) {
      continue;
    }
    const entryPath = path.join(root, relativePath);
    if (!existsSync(entryPath)) continue;
    const source = readFileSync(entryPath, 'utf8');
    if (legacyPatterns.some((pattern) => pattern.test(source))) {
      violations.push(relativePath);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `legacy Agent Qualification Lab identity remains reachable:\n${violations
        .sort()
        .join('\n')}`,
    );
  }
  process.stdout.write(
    '[agent-work-lab] legacy product identity absent outside immutable historical evidence\n',
  );
}

function assertEmbeddedSourceContractDependencies() {
  const cmake = readFileSync(
    path.join(root, 'framework/core/src/libkungfu/CMakeLists.txt'),
    'utf8',
  );
  const dependencyBlock = cmake.match(
    /set_property\(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ([^)]+)\)/u,
  )?.[1];
  for (const contract of [
    'kungfu-kfx.contract.json',
    'kungfu-kfx-domain-profile.contract.json',
  ]) {
    if (!dependencyBlock?.includes(contract)) {
      throw new Error(
        `${contract} must invalidate cached CMake configuration before its bytes are embedded`,
      );
    }
  }
  process.stdout.write(
    '[kfx-profile-suite] embedded source contracts invalidate cached CMake configuration\n',
  );
}

const pythonPath = [
  path.join(root, 'framework/core/src/python'),
  agentWorkLabOnly
    ? (process.env.KUNGFU_NATIVE_PATH ??
      path.join(root, 'framework/core/build/Release'))
    : null,
  process.env.PYTHONPATH,
]
  .filter(Boolean)
  .join(path.delimiter);

assertEmbeddedSourceContractDependencies();

if (agentWorkLabOnly) {
  assertNoLegacyProductIdentity();
  for (const [label, file] of [
    ['API capability adapter', 'framework/api/tests/agent-work-lab.test.ts'],
    [
      'TUI Getting Started',
      'framework/tui/src/agent-first-onboarding-view.test.ts',
    ],
    [
      'TUI deterministic Project onboarding',
      'framework/tui/src/starter-project-view.test.ts',
    ],
    [
      'API deterministic Project onboarding',
      'framework/api/tests/projects.test.ts',
    ],
    ['TUI experience', 'framework/tui/src/agent-work-lab-view.test.ts'],
    ['TUI workbench framework', 'framework/tui/src/profile-shell.test.ts'],
    ['Product TUI demo entry', 'product/scripts/product.test.mjs'],
    ['GUI experience', 'framework/gui/src/agent-work-lab.test.ts'],
    [
      'GUI source CLI fallback',
      'framework/gui/src/main/kungfu-cli-invocation.test.ts',
    ],
    ['KFX Manifest discovery', 'framework/kfx/src/profile-suite.test.ts'],
  ]) {
    const testPath = path.join(root, file);
    run(label, 'pnpm', [
      '--filter',
      '@kungfu-tech/tui',
      'exec',
      'tsx',
      '--test',
      testPath.startsWith(`${tuiRoot}${path.sep}`)
        ? path.relative(tuiRoot, testPath)
        : testPath,
    ]);
  }

  run(
    'Core Python format',
    'uv',
    [
      'run',
      '--project',
      path.join(root, 'framework/core'),
      '--frozen',
      'ruff',
      'format',
      '--check',
      path.join(
        root,
        'framework/core/src/python/kungfu/agent/runtime_profiles.py',
      ),
      path.join(
        root,
        'framework/core/src/python/kungfu/agent/work_projection.py',
      ),
      path.join(root, 'framework/core/src/python/kungfu/agent_work_lab.py'),
      path.join(
        root,
        'framework/core/src/python/kungfu/cli/commands/agent_work_lab.py',
      ),
      path.join(
        root,
        'framework/core/src/python/kungfu/project_template/__init__.py',
      ),
      path.join(root, 'framework/core/tests/python/test_agent_work_lab.py'),
      path.join(root, 'framework/core/tests/python/test_project_template.py'),
    ],
    { ...process.env, PYTHONPATH: pythonPath },
  );

  run(
    'Core plans, Work evidence, reports and CLI',
    'uv',
    [
      'run',
      '--project',
      path.join(root, 'framework/core'),
      '--frozen',
      'pytest',
      '-q',
      path.join(root, 'framework/core/tests/python/test_agent_work_lab.py'),
      path.join(root, 'framework/core/tests/python/test_project_template.py'),
    ],
    { ...process.env, PYTHONPATH: pythonPath },
  );

  run(
    'CLI catalog parity',
    'uv',
    [
      'run',
      '--project',
      path.join(root, 'framework/core'),
      '--frozen',
      'python',
      '-m',
      'kungfu.cli.catalog_projection',
      '--check',
    ],
    { ...process.env, PYTHONPATH: pythonPath },
  );
} else {
  run('Node contract fixtures', 'pnpm', [
    '--filter',
    '@kungfu-tech/tui',
    'exec',
    'tsx',
    '--test',
    path.join(root, 'framework/kfx/src/profile-suite.test.ts'),
  ]);

  for (const [label, file] of [
    [
      'GUI Profile navigation projection',
      'framework/gui/src/navigation.test.ts',
    ],
    [
      'GUI Agent Work Lab visual contract',
      'framework/gui/src/agent-work-lab.test.ts',
    ],
    ['GUI product search contract', 'framework/gui/src/product-search.test.ts'],
    [
      'GUI KFX shared-module contract',
      'framework/gui/src/renderer/shared-modules.test.ts',
    ],
    [
      'GUI workspace runtime foreground projection',
      'framework/gui/src/runtime-status.test.ts',
    ],
  ]) {
    run(label, 'pnpm', [
      '--filter',
      '@kungfu-tech/tui',
      'exec',
      'tsx',
      '--test',
      path.join(root, file),
    ]);
  }

  run(
    'Python contract fixtures',
    'uv',
    [
      'run',
      '--project',
      path.join(root, 'framework/core'),
      '--frozen',
      'pytest',
      path.join(root, 'framework/core/tests/python/test_kfx_contract.py'),
      '-k',
      'profile_suite',
    ],
    { ...process.env, PYTHONPATH: pythonPath },
  );
}
