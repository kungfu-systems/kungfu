// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  sourceAcceptancePlan,
  sourceMypyCommand,
  sourcePythonCommand,
} from './source-acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  assert.ok(labels.includes('runtime activation contract'));
  assert.ok(labels.includes('agent session contract'));
  assert.ok(labels.includes('durability production-candidate admission'));
  const typeBaseline = plan.find(
    (step) => step.label === 'Python type baseline',
  );
  assert.ok(['mypy', 'uvx'].includes(typeBaseline.command));
  assert.deepEqual(typeBaseline.args.slice(-3), [
    '--config-file',
    'pyproject.toml',
    'src/python/kungfu',
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
      'framework/agent-session/tests/product-surface.test.mjs',
    ),
  );
  assert.ok(
    !contractTests.args.includes(
      'framework/agent-session/tests/capsule-worker.test.mjs',
    ),
  );
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

test('reusable workflow is bound to source mode and the protected alpha channel', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/source-acceptance.yml'),
    'utf8',
  );
  assert.match(workflow, /mode: source/);
  assert.match(workflow, /check\.yml@v2-alpha/);
  assert.match(workflow, /buildchain-ref: v2-alpha/);
  assert.doesNotMatch(workflow, /self-hosted/);
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
