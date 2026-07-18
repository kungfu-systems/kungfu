// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  sourceAcceptancePlan,
  sourceClangFormatCommand,
  sourceMypyCommand,
  sourcePythonCommand,
} from './source-acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('type baseline covers every Python surface declared by [tool.mypy]', () => {
  // The three siblings of the core package are small but load-bearing
  // (public SDK, capability guest harness, extension domain logic). Changing
  // one must trigger the type baseline, and pyproject must actually check it —
  // otherwise the scope silently narrows back to the core package.
  const pyproject = fs.readFileSync(
    path.join(ROOT, 'framework/core/pyproject.toml'),
    'utf8',
  );
  const checked = [
    ['framework/sdk/python/kungfu_sdk/native.py', '"../sdk/python/kungfu_sdk"'],
    [
      'framework/api/src/capability/guest-harness/facet.py',
      '"../api/src/capability/guest-harness"',
    ],
    [
      'extensions/mission-control/mission-control-actions/adapter.py',
      '"../../extensions/mission-control/mission-control-actions"',
    ],
  ];
  for (const [changedFile, mypyEntry] of checked) {
    const labels = sourceAcceptancePlan([changedFile]).map((s) => s.label);
    assert.ok(
      labels.includes('Python type baseline'),
      `${changedFile} must trigger the type baseline`,
    );
    assert.ok(
      pyproject.includes(mypyEntry),
      `[tool.mypy] files must list ${mypyEntry}`,
    );
  }
});

test('Python source checks use uvx when a bare ruff is unavailable', () => {
  const command = sourcePythonCommand(
    ['format', '--check'],
    (candidate) => candidate === 'uvx',
  );
  assert.deepEqual(command, {
    command: 'uvx',
    args: ['ruff', 'format', '--check'],
  });
});

test('Python source checks use uv tool run when the uvx shim is absent', () => {
  const command = sourcePythonCommand(
    ['format', '--check'],
    (candidate) => candidate === 'uv',
  );
  assert.deepEqual(command, {
    command: 'uv',
    args: ['tool', 'run', 'ruff', 'format', '--check'],
  });
});

test('C++ source checks use the exact ambient formatter when it matches the repository pin', () => {
  const command = sourceClangFormatCommand(
    ['--dry-run', 'example.cpp'],
    (candidate) => candidate === 'clang-format',
    () => ({ status: 0, stdout: 'clang-format version 20.1.8\n' }),
  );
  assert.deepEqual(command, {
    command: 'clang-format',
    args: ['--dry-run', 'example.cpp'],
  });
});

test('C++ source checks isolate an incompatible ambient formatter behind pinned uvx', () => {
  const command = sourceClangFormatCommand(
    ['--dry-run', 'example.cpp'],
    (candidate) => candidate === 'clang-format' || candidate === 'uvx',
    () => ({ status: 0, stdout: 'clang-format version 13.0.0\n' }),
  );
  assert.deepEqual(command, {
    command: 'uvx',
    args: ['clang-format@20.1.8', '--dry-run', 'example.cpp'],
  });
});

test('Python type checks use the pinned CI mypy when it is healthy', () => {
  const command = sourceMypyCommand(
    ['--config-file', 'pyproject.toml'],
    (candidate) => candidate === 'mypy',
    () => ({ status: 0, stdout: 'mypy 1.20.2 (compiled: yes)\n' }),
  );
  assert.deepEqual(command, {
    command: 'mypy',
    args: ['--config-file', 'pyproject.toml'],
  });
});

test('Python type checks isolate a broken ambient mypy behind pinned uvx', () => {
  const command = sourceMypyCommand(
    ['--config-file', 'pyproject.toml'],
    (candidate) => candidate === 'mypy' || candidate === 'uvx',
    () => ({ status: 1, stderr: 'broken ambient mypy' }),
  );
  assert.deepEqual(command, {
    command: 'uvx',
    args: ['--from', 'mypy==1.20.2', 'mypy', '--config-file', 'pyproject.toml'],
  });
});

test('Python type checks use pinned uv tool run without a uvx shim', () => {
  const command = sourceMypyCommand(
    ['--config-file', 'pyproject.toml'],
    (candidate) => candidate === 'uv',
  );
  assert.deepEqual(command, {
    command: 'uv',
    args: [
      'tool',
      'run',
      '--from',
      'mypy==1.20.2',
      'mypy',
      '--config-file',
      'pyproject.toml',
    ],
  });
});

test('source plan covers representative source-only checks', () => {
  const plan = sourceAcceptancePlan([
    'scripts/example.mjs',
    'framework/core/src/python/example.py',
    'framework/core/src/example.cpp',
  ]);
  const labels = plan.map((step) => step.label);
  assert.ok(labels.includes('changed web source format and lint'));
  assert.ok(labels.includes('changed Python format'));
  assert.ok(labels.includes('Python type baseline'));
  assert.ok(labels.includes('changed C/C++ format'));
  assert.ok(labels.includes('documentation contracts'));
  assert.ok(labels.includes('core architecture contract'));
  assert.ok(labels.includes('core architecture negative fixtures'));
  assert.ok(labels.includes('core affected-native negative fixtures'));
  assert.ok(labels.includes('runtime activation contract'));
  assert.ok(labels.includes('runtime upgrade contract'));
  assert.ok(labels.includes('product upgrade qualification'));
  assert.ok(labels.includes('agent session contract'));
  assert.ok(labels.includes('Project Cut contract'));
  assert.ok(labels.includes('Project Cut settlement contract'));
  assert.ok(labels.includes('Project Cut composition contract'));
  assert.ok(labels.includes('Project Cut scoped composition admission'));
  assert.ok(labels.includes('durability production-candidate admission'));
  assert.ok(labels.includes('Buildchain KFD release evidence'));
  const kfdEvidence = plan.find(
    (step) => step.label === 'Buildchain KFD release evidence',
  );
  assert.deepEqual(kfdEvidence.args, [
    'scripts/buildchain-kfd-evidence.mjs',
    '--check',
  ]);
  const typeBaseline = plan.find(
    (step) => step.label === 'Python type baseline',
  );
  assert.ok(['mypy', 'uvx', 'uv'].includes(typeBaseline.command));
  // No path argument: the checked surface comes from `files` under [tool.mypy]
  // in framework/core/pyproject.toml, so verify and source-acceptance cannot
  // disagree about what is type-checked.
  assert.deepEqual(typeBaseline.args.slice(-2), [
    '--config-file',
    'pyproject.toml',
  ]);
  if (typeBaseline.command === 'uvx') {
    assert.deepEqual(typeBaseline.args.slice(0, 3), [
      '--from',
      'mypy==1.20.2',
      'mypy',
    ]);
  }
  assert.equal(typeBaseline.cwd, path.join(ROOT, 'framework/core'));
  const contractTests = plan.find(
    (step) => step.label === 'source-acceptance contract tests',
  );
  const agentWorkState = plan.find(
    (step) => step.label === 'agent work state contract and CLI parity',
  );
  assert.deepEqual(agentWorkState.args, [
    'scripts/run-agent-work-state-tests.mjs',
  ]);
  assert.ok(
    contractTests.args.includes('scripts/check-upgrade-contract.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes('scripts/probe-cpp-cmake-contract.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes('scripts/check-upgrade-qualification.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/upgrade-publication-admission.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes('scripts/check-typescript-files.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes('scripts/check-project-cut-contract.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-fact-cut-kernel-contract.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes('scripts/check-git-episode-provider.test.mjs'),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-project-cut-settlement.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-project-cut-composition.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-workspace-continuation.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'scripts/check-episode-admission-contract.test.mjs',
    ),
  );
  const phaseBPackageTests = plan.find(
    (step) => step.label === 'Phase B package identity contract tests',
  );
  assert.deepEqual(phaseBPackageTests.args, [
    '-m',
    'unittest',
    'scripts.test_prepare_kungfu_phase_b_package',
  ]);
  const upgradeTests = plan.find(
    (step) => step.label === 'runtime upgrade control-plane tests',
  );
  assert.deepEqual(upgradeTests.args, [
    'scripts/run-runtime-upgrade-tests.mjs',
  ]);
  const desktopUpdateTests = plan.find(
    (step) => step.label === 'desktop update adapter tests',
  );
  assert.deepEqual(desktopUpdateTests.args, [
    'scripts/run-desktop-update-tests.mjs',
  ]);
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/capsule-host.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/peer-transport.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/runtime-port.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/provider-adapters.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/interaction-port.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/codex-app-server-contract.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/codex-app-server-interaction.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/codex-app-server-recovery.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/codex-app-server-runtime.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/codex-app-server-product.test.mjs',
    ),
  );
  assert.ok(
    contractTests.args.includes(
      'framework/agent-session/tests/product-surface.test.mjs',
    ),
  );
  assert.ok(
    !contractTests.args.includes(
      'framework/agent-session/tests/capsule-worker.test.mjs',
    ),
  );
});

test('clang-format falls back to pinned uv tool run without a uvx shim', () => {
  const command = sourceClangFormatCommand(
    ['--dry-run', 'example.cpp'],
    (candidate) => candidate === 'uv',
  );
  assert.deepEqual(command, {
    command: 'uv',
    args: [
      'tool',
      'run',
      '--from',
      'clang-format==20.1.8',
      'clang-format',
      '--dry-run',
      'example.cpp',
    ],
  });
});

test('generated Xinfa and Project Cut evidence is not treated as web source', () => {
  const plan = sourceAcceptancePlan([
    '.xinfa/baselines/sha256/example/atlas.json',
    '.kungfu/project-cuts/sha256/example/receipt.json',
    'scripts/example.mjs',
  ]);
  const web = plan.find(
    (step) => step.label === 'changed web source format and lint',
  );
  assert.ok(web);
  assert.ok(web.args.includes('scripts/example.mjs'));
  assert.ok(!web.args.some((arg) => arg.startsWith('.xinfa/')));
  assert.ok(!web.args.some((arg) => arg.startsWith('.kungfu/')));
});

test('Conan recipe Python is linted without widening into the product type baseline', () => {
  const plan = sourceAcceptancePlan([
    'framework/core/.conan/recipes/rocksdb/conanfile.py',
  ]);
  const labels = plan.map((step) => step.label);
  assert.ok(labels.includes('changed Python format'));
  assert.ok(labels.includes('changed Python lint'));
  assert.ok(!labels.includes('Python type baseline'));
});

test('changed GUI TypeScript receives a file-scoped semantic check', () => {
  const plan = sourceAcceptancePlan([
    'framework/gui/src/renderer/src/runtime.ts',
    'framework/gui/src/renderer/src/app.tsx',
    'framework/gui/src/renderer/src/theme.css',
  ]);
  const typeCheck = plan.find(
    (step) => step.label === 'changed GUI TypeScript check',
  );
  assert.deepEqual(typeCheck?.args, [
    'scripts/check-typescript-files.mjs',
    '--project',
    'framework/gui/tsconfig.json',
    'framework/gui/src/renderer/src/runtime.ts',
    'framework/gui/src/renderer/src/app.tsx',
  ]);
});

test('RocksDB source archive keeps an explicit tar filename', () => {
  const recipe = fs.readFileSync(
    path.join(ROOT, 'framework/core/.conan/recipes/rocksdb/conanfile.py'),
    'utf8',
  );
  assert.match(recipe, /filename="rocksdb-source\.tar\.gz"/);
});

test('source plan cannot enter build, compiler, artifact, or release lifecycles', () => {
  const plan = sourceAcceptancePlan(['scripts/example.mjs']);
  const commands = plan
    .map((step) => [step.command, ...step.args].join(' '))
    .join('\n');
  assert.doesNotMatch(
    commands,
    /(?:^|\s)(?:cargo|rustc|cc|c\+\+|gcc|g\+\+|clang|cmake|conan|ninja)(?:\s|$)/im,
  );
  assert.doesNotMatch(
    commands,
    /(?:^|[\s:])(?:build|dist|package|freeze|verify|publish|release)(?:\s|$)/im,
  );
});

test('reusable workflow is bound to source mode and the pinned stable runtime', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/source-acceptance.yml'),
    'utf8',
  );
  assert.match(workflow, /mode: source/);
  assert.match(workflow, /check\.yml@ec48c0b311212c5f3a591e0284da6e85a9fdded5/);
  assert.match(workflow, /buildchain-ref: v2/);
  assert.doesNotMatch(workflow, /self-hosted/);
});

test('manual package build is welded to the reviewed Phase B consumer', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/build.yml'),
    'utf8',
  );
  assert.match(workflow, /run-kungfu-phase-b:\n\s+description:/);
  assert.match(
    workflow,
    /prepare_kungfu_phase_b_package\.py[\s\S]+--build-images-ref "v1\.2\.4-alpha\.29"[\s\S]+--build-images-sha "7cf672d83323fdd139ad90b6e8165a56e431cc6c"/,
  );
  assert.match(
    workflow,
    /uses: kungfu-systems\/build-images\/\.github\/workflows\/comparator-kungfu-package-smoke\.yml@7cf672d83323fdd139ad90b6e8165a56e431cc6c # v1\.2\.4-alpha\.29/,
  );
  assert.match(
    workflow,
    /package_artifact_name: \$\{\{ needs\.phase-b-package\.outputs\.artifact-name \}\}/,
  );
  assert.match(workflow, /retention-days: 30/);
});

test('the native membrane matrix is a promotion gate, not a dev PR gate', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/embedding-membrane-spike.yml'),
    'utf8',
  );
  const branchBlock = workflow.match(/branches:\n((?:\s+- .+\n)+)/)?.[1] || '';
  assert.match(branchBlock, /alpha\/v\*\/v\*/);
  assert.match(branchBlock, /release\/v\*\/v\*/);
  assert.doesNotMatch(branchBlock, /dev\/v\*\/v\*/);
});

test('documentation lint excludes the checked-out Buildchain runtime', async () => {
  const config = await import('../.markdownlint-cli2.mjs');
  assert.ok(config.default.globs.includes('!.buildchain/runtime/**'));
  assert.ok(config.default.globs.includes('!.buildchain/tmp/**'));
});
