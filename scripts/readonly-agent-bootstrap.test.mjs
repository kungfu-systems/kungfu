// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sourceMergeBase } from './source-acceptance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromGui = createRequire(
  path.join(ROOT, 'framework/gui/package.json'),
);

function copyFile(sourceRoot, targetRoot, relative) {
  const target = path.join(targetRoot, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, relative), target);
}

function semanticAmplificationFixturePaths(manifest) {
  const paths = new Set([
    'framework/core/architecture/layers.json',
    'framework/maintainability/semantic-amplification.manifest.json',
    'framework/maintainability/semantic-amplification.mjs',
    'framework/maintainability/terminal-evidence-matrix.json',
    manifest.reportPath,
  ]);
  for (const family of manifest.families || []) {
    for (const relative of family.authority?.sources || []) paths.add(relative);
    for (const surface of family.surfaces || []) {
      paths.add(surface.path);
      if (surface.generator) paths.add(surface.generator);
    }
  }
  for (const boundary of manifest.productionBoundaries || [])
    for (const relative of boundary.evidence || []) paths.add(relative);
  for (const record of manifest.decompositions || [])
    for (const relative of [
      ...(record.original || []),
      record.target,
      ...(record.tests || []),
    ])
      if (relative) paths.add(relative);
  return [...paths].sort();
}

function executableOnPath(name) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the declared PATH.
    }
  }
  throw new Error(`${name} is not available on PATH`);
}

function snapshotSource(root) {
  const rows = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git') continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (entry.isDirectory()) {
        rows.push(`d:${relative}`);
        visit(absolute);
      } else if (entry.isFile()) {
        rows.push(
          `f:${relative}:${crypto
            .createHash('sha256')
            .update(fs.readFileSync(absolute))
            .digest('hex')}`,
        );
      }
    }
  };
  visit(root);
  return rows;
}

function makeReadOnly(root) {
  const directories = [];
  const visit = (directory) => {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile())
        fs.chmodSync(absolute, entry.name === 'shifu' ? 0o555 : 0o444);
    }
  };
  visit(root);
  for (const directory of directories.reverse()) fs.chmodSync(directory, 0o555);
}

function restoreWritable(root) {
  if (!fs.existsSync(root)) return;
  const visit = (directory) => {
    fs.chmodSync(directory, 0o755);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) fs.chmodSync(absolute, 0o644);
    }
  };
  visit(root);
}

test('declared discovery routes are zero-write in a cold read-only fixture', (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX filesystem fixture; shifu.cmd parity is checked statically');
    return;
  }

  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu readonly bootstrap-'),
  );
  const fixture = path.join(temporary, 'source with spaces');
  const tools = path.join(temporary, 'tools');
  const home = path.join(temporary, 'cold home with spaces');
  const toolLog = path.join(temporary, 'unexpected-tool.log');
  fs.mkdirSync(tools);
  fs.mkdirSync(home);
  t.after(() => {
    restoreWritable(fixture);
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  const git = executableOnPath('git');
  const node = process.execPath;
  const cloned = spawnSync(
    git,
    ['clone', '--shared', '--quiet', ROOT, fixture],
    { encoding: 'utf8' },
  );
  assert.equal(cloned.status, 0, cloned.stderr);
  const base = sourceMergeBase();
  const corePytest = path.join(ROOT, 'framework/core/.venv/bin/pytest');
  const pytest = fs.existsSync(corePytest)
    ? corePytest
    : executableOnPath('pytest');
  const fixedBase = spawnSync(
    git,
    ['update-ref', 'refs/heads/dev/v4/v4.0', base.sha],
    {
      cwd: fixture,
      encoding: 'utf8',
    },
  );
  assert.equal(fixedBase.status, 0, fixedBase.stderr);
  const fixedProtectedBase = spawnSync(
    git,
    ['update-ref', 'refs/remotes/origin/dev/v4/v4.0', base.sha],
    {
      cwd: fixture,
      encoding: 'utf8',
    },
  );
  assert.equal(fixedProtectedBase.status, 0, fixedProtectedBase.stderr);
  for (const relative of [
    'shifu',
    'shifu.cmd',
    '.buildchain/kfd/support-matrix.json',
    '.buildchain/kfd/kfd-3/surfaces.json',
    '.buildchain/kfd/kfd-3/capability-query.json',
    '.buildchain/alpha-contract-lock.json',
    'developer/sdk/kfd/support-matrix.json',
    'docs/qualification/kfd-support-matrix.md',
    '.github/workflows/affected-native-cache-promote.yml',
    '.github/workflows/affected-native-pr.yml',
    '.github/workflows/aws-us-linux-burst-qualification.yml',
    '.github/workflows/aws-us-windows-burst-qualification.yml',
    '.github/workflows/cancel-dequeued-merge-group.yml',
    '.github/workflows/core-build-profiles.yml',
    '.github/workflows/kungfu-agent-patrol.yml',
    '.github/workflows/dev-alpha-candidate-patrol.yml',
    '.github/workflows/dev-verify-patrol.yml',
    '.github/workflows/gate-measurement.yml',
    '.github/workflows/build.yml',
    '.github/workflows/publish-layer-artifacts.yml',
    '.github/workflows/release-new-version.yml',
    '.github/alpha-attention-operations.json',
    'docs/qualification/gates/README.md',
    'docs/qualification/gates/dev-queue-admission.contract.json',
    'docs/qualification/gates/source-and-governance.md',
    'docs/qualification/gates/workflow-authority.json',
    'docs/qualification/gates/workflow-authority.md',
    'docs/qualification/gates/workflow-bindings.json',
    'framework/release/publication-surfaces.json',
    'docs/shifu/artifact-contract.json',
    'product/package.json',
    'crates/shifu/src/artifact_catalog.rs',
    'crates/shifu/src/promote.rs',
    'crates/shifu/src/registrar.rs',
    'framework/core/src/python/kungfu/distribution_update.py',
    'framework/core/tests/python/test_distribution_update.py',
    'scripts/candidate-timeline-events.cjs',
    'scripts/check-carrier-action-envelope.mjs',
    'scripts/check-project-cut-composition-gate.mjs',
    'scripts/check-runtime-greenfield.mjs',
    'scripts/check.mjs',
    'scripts/fix.mjs',
    'scripts/measure-dev-required-latency.mjs',
    'scripts/run-core-affected-native.mjs',
    'scripts/run-gate-measurement.mjs',
    'scripts/run-native-kfx-admission-tests.mjs',
    'scripts/kfd-support-matrix.mjs',
    'scripts/kungfu-invariant-discovery.mjs',
    'scripts/kungfu-invariant.mjs',
    'scripts/code-complexity-budget.mjs',
    'scripts/code-complexity-budget.test.mjs',
    'scripts/check-readonly-source-routes.mjs',
    'scripts/check-readonly-source-routes.test.mjs',
    'scripts/check-alpha-attention-operations.mjs',
    'scripts/check-docs.mjs',
    'scripts/check-incubation-passport.mjs',
    'scripts/check-incubation-passport.test.mjs',
    'scripts/check-hub-starter-docker-concept.mjs',
    'scripts/check-hub-starter-docker-concept.test.mjs',
    'scripts/check-evidence-envelope.test.mjs',
    'scripts/check-exit-bundle-contract.test.mjs',
    'scripts/check-fact-cut-kernel-contract.test.mjs',
    'scripts/check-git-episode-provider.test.mjs',
    'scripts/check-work-history-selector.test.mjs',
    'scripts/check-work-design-advisor.test.mjs',
    'scripts/documentation-product-pack.test.mjs',
    'scripts/docs-markdown-readonly.mjs',
    'scripts/kungfu-gate-workflow-facts.mjs',
    'scripts/kungfu-invariant.test.mjs',
    'scripts/kfd-support-matrix.mjs',
    'scripts/kfd-support-matrix.test.mjs',
    'scripts/kungfu-workflow-authority.mjs',
    'scripts/readonly-source-toolchain.mjs',
    'scripts/readonly-agent-bootstrap.test.mjs',
    'scripts/run-documentation-material-tests.mjs',
    'scripts/run-agent-work-state-tests.mjs',
    'scripts/run-desktop-update-tests.mjs',
    'scripts/run-runtime-upgrade-tests.mjs',
    'scripts/registry-envelope.mjs',
    'scripts/runtime-contract.mjs',
    'scripts/run-docs-source-check.mjs',
    'scripts/shifu-documentation-qualification.mjs',
    'scripts/shifu-readonly-entry.mjs',
    'scripts/shifu-cache-runtime.test.mjs',
    'scripts/source-acceptance.mjs',
    'scripts/verify-kungfu-release-admission.mjs',
    'scripts/verify-kungfu-release-admission.test.mjs',
    'scripts/check-work-lifecycle-operation-matrix.test.mjs',
    'scripts/buildchain-kfd-evidence.mjs',
    '.buildchain/kfd/kfd-3/collaboration-interface.artifact.json',
    '.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json',
    '.buildchain/kfd/kfd-3/surfaces.json',
    '.buildchain/kfd/support-matrix.json',
    'developer/sdk/kfd/kfd-3-surfaces.json',
    'developer/sdk/kfd/support-matrix.json',
    'developer/sdk/kfd/upstream-aggregate.json',
    'framework/core/package.json',
    'pnpm-lock.yaml',
    'framework/release/buildchain-kfd-runtime.mjs',
    'framework/release/qualified-assignment-core-artifact.mjs',
    'scripts/qualified-assignment-core-artifact.test.mjs',
    'framework/deprecation/deprecation-lifecycle.contract.json',
    'framework/deprecation/deprecation-lifecycle.mjs',
    'framework/deprecation/deprecation-registry.json',
    'framework/deprecation/deprecation-discovery.contract.json',
    'framework/deprecation/deprecation-surface-discovery.mjs',
    'framework/deprecation/deprecation-surface-discovery.test.mjs',
    'framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/journal.h',
    'framework/core/src/libyijinjing/include/kungfu/yijinjing/journal/page.h',
    'framework/core/src/libyijinjing/include/kungfu/yijinjing/platform/mmap.h',
    'scripts/adr-release-gate.test.mjs',
    'config/primitive/kungfu-primitive-catalog.contract.json',
    'framework/core/src/libkungfu/include/kungfu/sdk/generated/primitive_catalog_v2.hpp',
    'docs/qualification/gates/release-admission-policy.json',
    'framework/core/src/python/kungfu/agent/documentation.py',
    'framework/core/src/python/kungfu/cli/surface_contract.py',
    'framework/core/src/python/kungfu/cli/commands/env.py',
    'framework/core/src/python/kungfu/cli/commands/kfx.py',
    'framework/core/src/python/kungfu/cli/commands/shifu.py',
    'framework/maintainability/baseline-transitions/README.md',
    'framework/maintainability/code-complexity-policy.json',
    'framework/maintainability/code-complexity-baseline.json',
    'framework/maintainability/waivers/retired/hub-cli-linux-arm64-dist-platform-map.v1.json',
    'framework/maintainability/waivers/retired/hub-cli-linux-arm64-post-queue-workflow-authority.v1.json',
    'framework/maintainability/waivers/retired/hub-cli-linux-arm64-workflow-authority.v1.json',
    'framework/maintainability/waivers/retired/libnode-linux-arm64-lockfile.v1.json',
    'framework/maintainability/complexity-governance.mjs',
    'framework/maintainability/readonly-source-routes.json',
    'framework/maintainability/semantic-amplification.manifest.json',
    'framework/maintainability/semantic-amplification-report.json',
    'framework/maintainability/semantic-amplification.mjs',
    'framework/maintainability/waivers/README.md',
    'framework/work-history-selector/schema/work-history-selection-manifest-v1.schema.json',
    'framework/work-history-selector/schema/work-history-selection-request-v1.schema.json',
    'framework/work-history-selector/src/work-history-selector.mjs',
    'framework/work-history-selector/tooling/check-work-history-selector.mjs',
    'framework/work-history-selector/tooling/work-history-selector-contract.mjs',
    'framework/work-history-selector/work-history-selector.contract.json',
    'framework/work-design-advisor/schema/work-design-advice-request-v1.schema.json',
    'framework/work-design-advisor/schema/work-design-advice-v1.schema.json',
    'framework/work-design-advisor/schema/work-design-advice-verification-v1.schema.json',
    'framework/work-design-advisor/schema/work-design-disposition-v1.schema.json',
    'framework/work-design-advisor/src/work-design-advisor.mjs',
    'framework/work-design-advisor/tooling/check-work-design-advisor.mjs',
    'framework/work-design-advisor/tooling/work-design-advisor-contract.mjs',
    'framework/work-design-advisor/work-design-advisor.contract.json',
  ])
    copyFile(ROOT, fixture, relative);
  const amplificationManifest = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        'framework',
        'maintainability',
        'semantic-amplification.manifest.json',
      ),
      'utf8',
    ),
  );
  for (const relative of semanticAmplificationFixturePaths(
    amplificationManifest,
  ))
    copyFile(ROOT, fixture, relative);
  const matrix = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, '.buildchain', 'kfd', 'support-matrix.json'),
      'utf8',
    ),
  );
  const evidencePaths = new Set();
  for (const row of matrix.rows) {
    for (const section of [
      row.verification?.evidenceRoots,
      row.releaseQualification?.evidenceRoots,
    ]) {
      for (const evidence of section || []) evidencePaths.add(evidence.path);
    }
  }
  for (const relative of evidencePaths) copyFile(ROOT, fixture, relative);
  fs.chmodSync(path.join(fixture, 'shifu'), 0o755);

  fs.symlinkSync(git, path.join(tools, 'git'));
  fs.symlinkSync(node, path.join(tools, 'node'));
  for (const [name, relative] of [
    ['ruff', 'framework/core/.venv/bin/ruff'],
    ['mypy', 'framework/core/.venv/bin/mypy'],
    ['clang-format', 'framework/core/.venv/bin/clang-format'],
  ]) {
    const projectExecutable = path.join(ROOT, relative);
    const executable = fs.existsSync(projectExecutable)
      ? projectExecutable
      : executableOnPath(name);
    fs.symlinkSync(executable, path.join(tools, name));
  }
  for (const name of ['cargo', 'corepack', 'curl', 'fnm', 'pnpm', 'uv']) {
    const file = path.join(tools, name);
    fs.writeFileSync(
      file,
      '#!/bin/sh\nprintf "%s\\n" "$0" >> "$KUNGFU_READONLY_TOOL_LOG"\nexit 99\n',
    );
    fs.chmodSync(file, 0o755);
  }

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Kungfu Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@kungfu.invalid',
    GIT_COMMITTER_NAME: 'Kungfu Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@kungfu.invalid',
  };
  for (const args of [
    ['config', 'core.fileMode', 'false'],
    ['add', '.'],
    ['commit', '--allow-empty', '--quiet', '-m', 'readonly fixture'],
  ]) {
    const result = spawnSync(git, args, {
      cwd: fixture,
      encoding: 'utf8',
      env: gitEnv,
    });
    assert.equal(result.status, 0, result.stderr);
  }

  const before = snapshotSource(fixture);
  const protectedRef = base.sha;
  makeReadOnly(fixture);
  fs.chmodSync(home, 0o555);
  const env = {
    ...process.env,
    HOME: home,
    XDG_CACHE_HOME: path.join(home, 'cache'),
    XDG_CONFIG_HOME: path.join(home, 'config'),
    KUNGFU_READONLY_TOOL_LOG: toolLog,
    KUNGFU_READONLY_NESTED_SOURCE_ACCEPTANCE: '1',
    KUNGFU_READONLY_PYTEST: pytest,
    KUNGFU_DEV_BRANCH: 'dev/v4/v4.0',
    KUNGFU_READONLY_TSX: requireFromGui.resolve('tsx/cli'),
    KUNGFU_READONLY_BIOME: path.join(
      ROOT,
      'node_modules/@biomejs/biome/bin/biome',
    ),
    KUNGFU_COMPLEXITY_PROTECTED_REF: protectedRef,
    PATH: `${tools}:/usr/bin:/bin`,
  };
  const cases = [
    [
      'architecture',
      [
        'core:architecture',
        '--path',
        'framework/core/src/libkungfu/src/runtime/storage/service.cpp',
        '--json',
      ],
      'kungfu.core-architecture-query/v1',
    ],
    [
      'architecture-health',
      ['core:architecture:health', '--json'],
      'kungfu.core-architecture-health/v1',
    ],
    [
      'invariant-discovery',
      ['invariant:verify', '--', '--list', '--json'],
      'kungfu.invariant-discovery/v1',
    ],
    [
      'complexity-budget',
      ['maintainability:complexity', '--json'],
      'kungfu.code-complexity-budget-report/v1',
    ],
    [
      'semantic-amplification',
      ['maintainability:amplification', '--json'],
      'kungfu.semantic-amplification-report/v1',
    ],
    [
      'task-graph',
      ['maintainability:query', 'storage-query', '--json'],
      'kungfu.maintainability-task-graph/v1',
    ],
    ['kfd-status', ['kfd', 'status', '--json'], 'shifu.kfd-source-report/v1'],
    [
      'kfd-query',
      ['kfd', 'query', 'KFD-3', '--json'],
      'shifu.kfd-source-report/v1',
    ],
    ['kfd-check', ['kfd', 'check', '--json'], 'shifu.kfd-source-report/v1'],
    [
      'kfd-query-alias',
      ['kfd:query', 'KFD-3', '--json'],
      'shifu.kfd-source-report/v1',
    ],
    [
      'kfd-check-alias',
      ['kfd:support-matrix:check', '--json'],
      'shifu.kfd-source-report/v1',
    ],
  ];
  for (let iteration = 0; iteration < 2; iteration += 1) {
    for (const [name, args, schema] of cases) {
      const result = spawnSync(path.join(fixture, 'shifu'), args, {
        cwd: fixture,
        encoding: 'utf8',
        env,
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.equal(
        result.status,
        0,
        `${name} iteration ${iteration}: ${result.stderr || result.stdout}`,
      );
      assert.equal(JSON.parse(result.stdout).schema, schema);
      assert.deepEqual(
        fs.readdirSync(home),
        [],
        `${name} iteration ${iteration} wrote into HOME`,
      );
    }
  }
  const sourceAcceptance = spawnSync(
    path.join(fixture, 'shifu'),
    ['check:source'],
    {
      cwd: fixture,
      encoding: 'utf8',
      env,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    },
  );
  assert.equal(
    sourceAcceptance.status,
    0,
    `check:source:\n${[sourceAcceptance.stderr, sourceAcceptance.stdout]
      .filter(Boolean)
      .join('\n')}`,
  );
  assert.deepEqual(snapshotSource(fixture), before);
  assert.equal(fs.existsSync(toolLog), false, 'bootstrap tool was invoked');
  assert.deepEqual(fs.readdirSync(home), [], 'read-only route wrote into HOME');
  assert.equal(
    spawnSync(git, ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: fixture,
      encoding: 'utf8',
      env,
    }).stdout,
    '',
  );
});
