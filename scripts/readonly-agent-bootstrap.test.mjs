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
  for (const topology of manifest.integrityPolicy?.topologies || []) {
    for (const relative of topology.authority?.sources || [])
      paths.add(relative);
    for (const adapter of topology.adapters || [])
      for (const relative of adapter.paths || []) paths.add(relative);
    for (const projection of topology.projections || [])
      if (projection.path) paths.add(projection.path);
    for (const qualification of topology.qualification || [])
      if (qualification.path) paths.add(qualification.path);
    for (const detector of topology.detectors || [])
      for (const relative of detector.paths || []) paths.add(relative);
  }
  return [...paths].sort();
}

function workProfileConformanceFixturePaths(manifest) {
  const paths = new Set([
    'config/kungfu-kfx.contract.json',
    'extensions/work-control/profile.json',
    'extensions/work-control/qualification/work-profile-conformance.json',
    'framework/kfx/kungfu-kfx.contract.json',
    'framework/work-profile-conformance/authority-manifest.json',
    'framework/work-profile-conformance/generate-qualification.mjs',
    'framework/work-profile-conformance/qualification/negative-witnesses.json',
    'framework/work-profile-conformance/qualification/reference-scenarios.json',
    'framework/work-profile-conformance/qualification/retained-witnesses.json',
    'framework/work-profile-conformance/schema/work-profile-conformance-declaration-v1.schema.json',
    'framework/work-profile-conformance/schema/work-profile-conformance-result-v1.schema.json',
    'framework/work-profile-conformance/work-profile-conformance.mjs',
  ]);
  for (const file of manifest.files || []) {
    if (file.path) paths.add(file.path);
  }
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

function pinnedUvToolExecutable(packageSpec, name) {
  const result = spawnSync(
    executableOnPath('uv'),
    ['tool', 'run', '--from', packageSpec, 'which', name],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(
      `could not resolve ${packageSpec}: ${result.stderr || result.stdout}`,
    );
  }
  return declaredExecutable(name, result.stdout.trim());
}

function pinnedClangFormatExecutable() {
  const candidates = [path.join(ROOT, 'framework/core/.venv/bin/clang-format')];
  try {
    candidates.push(executableOnPath('clang-format'));
  } catch {
    // The pinned uv fallback below remains available when PATH has no formatter.
  }
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const version = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (
      version.status === 0 &&
      /clang-format version 20\.1\.8(?:\s|$)/u.test(version.stdout)
    )
      return declaredExecutable('clang-format', candidate);
  }
  return pinnedUvToolExecutable('clang-format==20.1.8', 'clang-format');
}

function declaredExecutable(name, candidate) {
  if (!candidate) return null;
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return candidate;
  } catch {
    throw new Error(`${name} is not executable: ${candidate}`);
  }
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

function sourceAuditRoot(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) hash.update(row).update('\0');
  return `sha256:${hash.digest('hex')}`;
}

function boundedDiagnosticTail(...values) {
  const output = values.filter(Boolean).join('\n');
  const lines = output.split(/\r?\n/u);
  const failingTestsIndex = lines.findLastIndex(
    (line) => line.trim() === '✖ failing tests:',
  );
  if (failingTestsIndex >= 0)
    return lines
      .slice(failingTestsIndex, failingTestsIndex + 120)
      .join('\n')
      .slice(0, 24 * 1024);
  const failureSummaryIndex = lines.findLastIndex((line) =>
    /^(?:ℹ fail [1-9]|# fail [1-9])/u.test(line.trimStart()),
  );
  if (failureSummaryIndex >= 0) {
    const failedTestIndex = lines.findLastIndex(
      (line, index) => index < failureSummaryIndex && /^not ok \d+/u.test(line),
    );
    return lines
      .slice(
        Math.max(
          0,
          failedTestIndex >= 0 ? failedTestIndex : failureSummaryIndex - 80,
        ),
        failureSummaryIndex + 40,
      )
      .join('\n')
      .slice(0, 24 * 1024);
  }
  return output.slice(-24 * 1024);
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
  const exactSource = spawnSync(git, ['-C', ROOT, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  assert.equal(exactSource.status, 0, exactSource.stderr);
  const exactSourceSha = exactSource.stdout.trim();
  assert.match(exactSourceSha, /^[0-9a-f]{40}$/u);
  const cloned = spawnSync(
    git,
    ['clone', '--shared', '--quiet', ROOT, fixture],
    { encoding: 'utf8' },
  );
  assert.equal(cloned.status, 0, cloned.stderr);
  const exactCheckout = spawnSync(
    git,
    ['checkout', '--detach', '--quiet', exactSourceSha],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(exactCheckout.status, 0, exactCheckout.stderr);
  const fixtureHead = spawnSync(git, ['rev-parse', 'HEAD'], {
    cwd: fixture,
    encoding: 'utf8',
  });
  assert.equal(fixtureHead.status, 0, fixtureHead.stderr);
  assert.equal(fixtureHead.stdout.trim(), exactSourceSha);
  const base = sourceMergeBase();
  const corePytest = path.join(ROOT, 'framework/core/.venv/bin/pytest');
  const pytest =
    declaredExecutable(
      'KUNGFU_READONLY_PYTEST',
      process.env.KUNGFU_READONLY_PYTEST,
    ) || (fs.existsSync(corePytest) ? corePytest : executableOnPath('pytest'));
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
    '.xinfa/portable-atlas-classification.json.gz',
    '.xinfa/product-atlas-bundle.json',
    '.buildchain/kfd/kfd-1/contract-world.witness.json',
    '.buildchain/kfd/kfd-1/release-gate.json',
    '.buildchain/kfd/kfd-1/verify-result.json',
    '.buildchain/kfd/support-matrix.json',
    '.buildchain/kfd/kfd-2/registry.json',
    '.buildchain/kfd/kfd-2/buildchain-claim-args.txt',
    '.buildchain/kfd/kfd-2/release-claims.json',
    '.buildchain/kfd/kfd-2/claims/agent-onboarding-pack.json',
    '.buildchain/kfd/kfd-1/documentation-consumers.witness.json',
    '.buildchain/kfd/kfd-1/documentation-pack.witness.json',
    '.buildchain/kfd/kfd-2/claims/agent-work-state-contract.json',
    '.buildchain/kfd/kfd-2/claims/codex-report-receipts.json',
    '.buildchain/kfd/kfd-2/claims/cross-language-authority-membrane.json',
    '.buildchain/kfd/kfd-2/claims/remote-fact-boundary.json',
    '.buildchain/kfd/kfd-3/surfaces.json',
    '.buildchain/kfd/kfd-3/capability-query.json',
    '.buildchain/alpha-release-cut-lock.json',
    '.buildchain/alpha-contract-lock.json',
    'config/kungfu-agent-first-canonical-policy.json',
    'config/primitive/kungfu-primitive-catalog.contract.json',
    'developer/sdk/kfd/kfd-1/contract-world.witness.json',
    'developer/sdk/kfd/kfd-1/release-gate.json',
    'developer/sdk/kfd/kfd-1/verify-result.json',
    'developer/sdk/kfd/kfd-2/buildchain-claim-args.txt',
    'developer/sdk/kfd/support-matrix.json',
    'docs/qualification/kfd-support-matrix.md',
    '.github/actions/qualified-core-candidate-build/action.yml',
    '.github/actions/upload-qualified-core-matrix/action.yml',
    '.github/workflows/affected-native-cache-promote.yml',
    '.github/workflows/affected-native-pr.yml',
    '.github/workflows/dev-post-merge-advisory.yml',
    '.github/workflows/aws-us-linux-burst-qualification.yml',
    '.github/workflows/aws-us-windows-burst-qualification.yml',
    '.github/workflows/cancel-dequeued-merge-group.yml',
    '.github/workflows/core-build-profiles.yml',
    '.github/workflows/kungfu-agent-patrol.yml',
    '.github/workflows/dev-alpha-candidate-patrol.yml',
    '.github/workflows/dev-delivery-warrant-terminal.yml',
    '.github/workflows/dev-pr-auto-merge.yml',
    '.github/workflows/queue-admission-lease.yml',
    '.github/workflows/dev-gate-latency-patrol.yml',
    '.github/workflows/dev-verify-patrol.yml',
    '.github/workflows/gate-measurement.yml',
    '.github/workflows/report-projection.yml',
    '.github/workflows/build.yml',
    '.github/workflows/publish-layer-artifacts.yml',
    '.github/workflows/python-structure.yml',
    '.github/workflows/release-new-version.yml',
    '.github/workflows/stable-candidate-patrol.yml',
    '.github/actionlint.yaml',
    '.github/actions/native-execution-under-warrant/action.yml',
    '.github/actions/require-alpha-preflight/alpha-macos-overflow.mjs',
    '.github/alpha-attention-operations.json',
    'docs/qualification/gates/README.md',
    'docs/development/buildchain.md',
    'docs/qualification/gates/dev-queue-admission.contract.json',
    'docs/qualification/gates/source-and-governance.md',
    'docs/qualification/gates/release-and-promotion.md',
    'docs/qualification/gates/workflow-authority.json',
    'docs/qualification/gates/workflow-authority.md',
    'docs/qualification/gates/workflow-bindings.json',
    'docs/qualification/alpha-ruleset.contract.json',
    'docs/qualification/stable-ruleset.contract.json',
    'docs/qualification/stable-release-continuation.contract.json',
    'docs/adr/KF-ADR-019f96a2-c686-76e1-9261-f6106aa50429.md',
    'docs/adr/KF-ADR-019fbbe4-40c5-7c67-9ed2-910a65430ff7.md',
    'docs/adr/SHIFU-ADR-019fab1a-2853-737e-8c67-a9b1aa9035aa.md',
    'docs/adr/SHIFU-ADR-019f86da-4f90-79a1-bc85-4b542fecf011.md',
    'docs/adr/KF-ADR-019fbe04-6548-7b3a-8358-22c8fe8238a9.md',
    'docs/architecture/adr-map.json',
    'docs/architecture/adr-map.md',
    'framework/release/publication-surfaces.json',
    'framework/release/publication-control-plane.mjs',
    'framework/dev-delivery/native-execution-under-warrant.mjs',
    'scripts/release-publication-control-plane.test.mjs',
    'framework/release/kungfu-release-provenance.contract.json',
    'config/release/kungfu-release-provenance.contract.json',
    'framework/release/kungfu-temporal-release-admission.contract.json',
    'config/release/kungfu-temporal-release-admission.contract.json',
    'framework/core/src/python/kungfu/release_provenance/__init__.py',
    'framework/core/tests/python/test_release_provenance.py',
    'scripts/affected-native-semantic-source.test.mjs',
    'scripts/check-release-provenance-object.test.mjs',
    'scripts/release-provenance-object.py',
    'tests/fixtures/release-provenance-object/cases.json',
    'framework/core/architecture/dev-gate-latency-baseline.json',
    'framework/version-line/check-version-line-authority.mjs',
    'framework/version-line/version-line-authority.json',
    'framework/version-line/version-line-authority.mjs',
    'framework/version-line/version-line-projections.json',
    'docs/shifu/README.md',
    'framework/contract/kungfu-agent-first-canonical-policy.json',
    'framework/core/src/libkungfu/include/kungfu/sdk/generated/primitive_catalog_v2.hpp',
    'framework/incubation/incubation-passport.baseline.json',
    'framework/incubation/incubation-passport.registry.json',
    'docs/shifu/artifact-contract.json',
    'docs/shifu/cache-contract.json',
    'docs/shifu/core-production-subgraph-contract.json',
    'docs/shifu/examples/production-graph/cancelled.fixture.json',
    'docs/shifu/examples/production-graph/admission/admitted.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/actor-mismatch.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/attempt-mismatch.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/expired-authorization.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/expired-work-lease.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/graph-drift.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/missing-authorization.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/missing-work.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/node-set-mismatch.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/replayed-authorization.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/shifu-authority.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/stale-authorization.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/stale-work.fixture.json',
    'docs/shifu/examples/production-graph/admission/invalid/unauthorized.fixture.json',
    'docs/shifu/examples/production-graph/failed.fixture.json',
    'docs/shifu/examples/production-graph/feedback/authority-drift.fixture.json',
    'docs/shifu/examples/production-graph/feedback/cancellation.fixture.json',
    'docs/shifu/examples/production-graph/feedback/failure.fixture.json',
    'docs/shifu/examples/production-graph/feedback/missing-evidence.fixture.json',
    'docs/shifu/examples/production-graph/feedback/project-independent.fixture.json',
    'docs/shifu/examples/production-graph/feedback/restart.fixture.json',
    'docs/shifu/examples/production-graph/feedback/source-drift.fixture.json',
    'docs/shifu/examples/production-graph/feedback/success.fixture.json',
    'docs/shifu/examples/production-graph/result-projection/cancellation.fixture.json',
    'docs/shifu/examples/production-graph/result-projection/failure.fixture.json',
    'docs/shifu/examples/production-graph/result-projection/partial-output.fixture.json',
    'docs/shifu/examples/production-graph/result-projection/success.fixture.json',
    'docs/shifu/examples/production-graph/result-projection/invalid/completeness-mismatch.fixture.json',
    'docs/shifu/examples/production-graph/result-projection/invalid/execution-receipt-drift.fixture.json',
    'docs/shifu/examples/production-graph/result-projection/invalid/missing-digest.fixture.json',
    'docs/shifu/examples/production-graph/result-projection/invalid/settlement-receipt-mismatch.fixture.json',
    'docs/shifu/examples/production-graph/result-projection/invalid/source-drift.fixture.json',
    'docs/shifu/examples/production-graph/invalid/authority-drift.fixture.json',
    'docs/shifu/examples/production-graph/invalid/dependency-cycle.fixture.json',
    'docs/shifu/examples/production-graph/invalid/missing-dependency.fixture.json',
    'docs/shifu/examples/production-graph/invalid/missing-root.fixture.json',
    'docs/shifu/examples/production-graph/invalid/plan-receipt-mismatch.fixture.json',
    'docs/shifu/examples/production-graph/invalid/recovery-mismatch.fixture.json',
    'docs/shifu/examples/production-graph/invalid/source-drift.fixture.json',
    'docs/shifu/examples/production-graph/invalid/unknown-field.fixture.json',
    'docs/shifu/examples/production-graph/qualified.fixture.json',
    'docs/shifu/examples/production-graph/core-production-subgraph/journal.fixture.json',
    'docs/shifu/examples/production-graph/core-production-subgraph/invalid/dependency-edge.fixture.json',
    'docs/shifu/examples/production-graph/core-production-subgraph/invalid/input-root.fixture.json',
    'docs/shifu/examples/production-graph/core-production-subgraph/invalid/output-root.fixture.json',
    'docs/shifu/examples/production-graph/core-production-subgraph/invalid/project-authority-root.fixture.json',
    'docs/shifu/examples/production-graph/core-production-subgraph/invalid/responsibility.fixture.json',
    'docs/shifu/examples/production-graph/core-production-subgraph/invalid/source-root.fixture.json',
    'docs/shifu/examples/production-graph/core-production-subgraph/invalid/xinfa-root.fixture.json',
    'docs/shifu/production-graph-contract.json',
    'docs/shifu/schema/core-production-subgraph-compile-request-v0.schema.json',
    'docs/shifu/schema/core-production-subgraph-plan-v0.schema.json',
    'docs/shifu/schema/core-production-subgraph-v0.schema.json',
    'docs/shifu/schema/core-production-subgraph-verification-receipt-v0.schema.json',
    'docs/shifu/schema/production-graph-execution-event-v0.schema.json',
    'docs/shifu/schema/production-graph-execution-admission-request-v0.schema.json',
    'docs/shifu/schema/production-graph-execution-admission-rejection-v0.schema.json',
    'docs/shifu/schema/production-graph-execution-admission-decision-v0.schema.json',
    'docs/shifu/schema/production-graph-execution-admission-verification-receipt-v0.schema.json',
    'docs/shifu/schema/production-graph-failure-v0.schema.json',
    'docs/shifu/schema/production-graph-plan-v0.schema.json',
    'docs/shifu/schema/production-graph-receipt-v0.schema.json',
    'docs/shifu/schema/production-graph-recovery-v0.schema.json',
    'docs/shifu/schema/production-graph-feedback-v0.schema.json',
    'docs/shifu/schema/production-graph-v0.schema.json',
    'docs/shifu/schema/production-graph-verification-receipt-v0.schema.json',
    'docs/shifu/schema/production-graph-local-execution-receipt-v0.schema.json',
    'docs/shifu/schema/production-graph-local-executor-policy-v0.schema.json',
    'docs/shifu/schema/production-graph-build-result-v0.schema.json',
    'docs/shifu/schema/production-graph-build-result-settlement-receipt-v0.schema.json',
    'docs/shifu/qualified-assignment-core-platform-matrix.json',
    'docs/shifu/schema/qualified-assignment-core-platform-matrix-v1.schema.json',
    'framework/production-graph/check.mjs',
    'framework/production-graph/check.test.mjs',
    'framework/production-graph/admission/index.mjs',
    'framework/production-graph/compiler/index.mjs',
    'framework/production-graph/feedback/index.mjs',
    'framework/production-graph/executor/index.mjs',
    'framework/production-graph/executor/index.test.mjs',
    'framework/production-graph/result-projection/index.mjs',
    'framework/production-graph/result-projection/index.test.mjs',
    'framework/production-graph/compiler/polyglot.fixture.mjs',
    'framework/production-graph/contract.mjs',
    'framework/production-graph/core-subgraph/index.mjs',
    'framework/production-graph/core-subgraph/index.test.mjs',
    'product/package.json',
    'product/scripts/release-channel-index.mjs',
    'product/scripts/release-channel-index.test.mjs',
    'product/scripts/upgrade-manifest.test.mjs',
    'crates/shifu/src/artifact_catalog.rs',
    'crates/shifu/src/main.rs',
    'crates/shifu/src/native_update.rs',
    'crates/shifu/src/promote.rs',
    'crates/shifu/src/promote_desktop.rs',
    'crates/shifu/src/promote_tests.rs',
    'crates/shifu/src/registrar.rs',
    'config/kungfu-skill.contract.json',
    'config/kungfu-contracts.registry.json',
    'docs/adr/KF-ADR-019f86da-4f90-74c2-9cbb-24f1c34303bf.md',
    'docs/document-metadata.contract.json',
    'docs/adr/KF-ADR-019fee22-e71d-7da9-8a44-9403c21a5d62.md',
    'docs/architecture/skills.md',
    'framework/skill/README.md',
    'framework/skill/fixtures/contract-v2/cases.json',
    'framework/skill/kungfu-skill.contract.json',
    'framework/skill/package.json',
    'framework/skill/schema/skill-definition-v2.schema.json',
    'framework/skill/schema/skill-dependency-invocation-receipt-v2.schema.json',
    'framework/skill/schema/skill-dependency-plan-v2.schema.json',
    'framework/skill/schema/skill-lifecycle-plan-v2.schema.json',
    'framework/skill/schema/skill-lifecycle-receipt-v2.schema.json',
    'framework/skill/schema/skill-registry-state-v2.schema.json',
    'framework/skill/scripts/contract-v2.mjs',
    'framework/skill/scripts/registry.mjs',
    'framework/skill/src/index.ts',
    'framework/core/src/python/kungfu/agent/cli_surface.catalog.json',
    'framework/core/src/python/kungfu/agent/__init__.py',
    'framework/core/src/python/kungfu/cli/commands/skill.py',
    'framework/core/src/python/kungfu/cli/surface_contract.registry.json',
    'framework/core/src/python/kungfu/skill/__init__.py',
    'framework/core/src/python/kungfu/skill/contract.py',
    'framework/core/src/python/kungfu/skill/registry.py',
    'framework/core/tests/python/test_skill.py',
    'framework/core/tests/python/test_skill_lifecycle.py',
    'framework/core/src/python/kungfu/distribution_update.py',
    'framework/core/src/python/kungfu/distribution_update_planning.py',
    'framework/core/src/python/kungfu/distribution_update_policy.py',
    'framework/core/src/python/kungfu/profile_sdk_kfd3.py',
    'framework/core/src/python/kungfu/profile_sdk_source.py',
    'framework/core/src/python/kungfu/profile_sdk_support.py',
    'framework/core/src/python/kungfu/exit_bundle.py',
    'framework/core/src/python/kungfu/exit_verifier.py',
    'framework/core/src/python/kungfu/release_channel.py',
    'framework/core/src/python/kungfu/runtime_upgrade.py',
    'framework/core/tests/python/test_distribution_release_cut.py',
    'framework/core/tests/python/test_distribution_update.py',
    'framework/core/tests/python/test_release_channel.py',
    'framework/core/tests/python/test_release_cut.py',
    'framework/primitive/kungfu-primitive-catalog.contract.json',
    'framework/invariant/kungfu-invariant.registry.json',
    'framework/registry/contract.registry-envelope.json',
    'framework/registry/invariant.registry-envelope.json',
    'config/invariant/kungfu-invariant.registry.json',
    'docs/adr/KF-ADR-019fabb5-62a0-7b8d-8f8d-6505efdbc239.md',
    'docs/architecture/adr-map.json',
    'docs/architecture/adr-map.md',
    'scripts/candidate-timeline-events.cjs',
    'scripts/check-carrier-action-envelope.mjs',
    'scripts/check-project-cut-composition-gate.mjs',
    'scripts/check-runtime-greenfield.mjs',
    'scripts/check.mjs',
    'scripts/fix.mjs',
    'scripts/measure-dev-required-latency.mjs',
    'scripts/alpha-ruleset.mjs',
    'scripts/alpha-ruleset.test.mjs',
    'scripts/stable-candidate-patrol.test.mjs',
    'scripts/version-line-authority.test.mjs',
    'scripts/linux-arm64-alpha-qualification-workflow.test.mjs',
    'scripts/run-core-affected-native.mjs',
    'scripts/run-gate-measurement.mjs',
    'scripts/run-native-kfx-admission-tests.mjs',
    'scripts/kfd-support-matrix.mjs',
    'scripts/kungfu-invariant-discovery.mjs',
    'scripts/kungfu-invariant.mjs',
    'scripts/code-complexity-budget.mjs',
    'scripts/code-complexity-budget.test.mjs',
    'scripts/check-code-complexity.mjs',
    'scripts/check-code-complexity.test.mjs',
    'scripts/check-python-structure.py',
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
    'scripts/check-work-design-policy-replay.test.mjs',
    'scripts/check-work-design-preflight.test.mjs',
    'scripts/check-agent-work-state-contract.test.mjs',
    'scripts/documentation-product-pack.test.mjs',
    'scripts/docs-markdown-readonly.mjs',
    'scripts/kungfu-gate-workflow-facts.mjs',
    'scripts/affected-native-proof.test.mjs',
    'scripts/dev-delivery-proof-consumer.test.mjs',
    'scripts/dev-delivery-warrant-input.test.mjs',
    'scripts/dev-pr-auto-merge.test.mjs',
    'scripts/native-execution-under-warrant.test.mjs',
    'scripts/queue-admission-lease.test.mjs',
    'scripts/kungfu-invariant.test.mjs',
    'scripts/kfd-support-matrix.mjs',
    'scripts/kfd-support-matrix.test.mjs',
    'scripts/kungfu-workflow-authority.mjs',
    'scripts/readonly-source-toolchain.mjs',
    'scripts/readonly-agent-bootstrap.test.mjs',
    'scripts/affected-native-proof.mjs',
    'scripts/dev-delivery-proof-consumer.test.mjs',
    'framework/core/tests/fixtures/dev-delivery-warrant-steady-state.json',
    'scripts/generate-kfx-authoring-kit.mjs',
    'scripts/run-documentation-material-tests.mjs',
    'scripts/portable-atlas-bundle.mjs',
    'scripts/portable-atlas-bundle.test.mjs',
    'scripts/run-agent-work-state-tests.mjs',
    'scripts/run-desktop-update-tests.mjs',
    'scripts/run-runtime-upgrade-tests.mjs',
    'scripts/registry-envelope.mjs',
    'scripts/runtime-contract.mjs',
    'scripts/run-docs-source-check.mjs',
    'scripts/shifu-documentation-consumers.mjs',
    'scripts/shifu-documentation-qualification.mjs',
    'scripts/shifu-readonly-entry.mjs',
    'scripts/shifu-cache-runtime.test.mjs',
    'scripts/source-acceptance.mjs',
    'scripts/verify-agent-pack.mjs',
    'framework/site/src/kfx-site-impact.contract.json',
    'framework/site/tooling/check-kfx-site-impact.mjs',
    'scripts/check-kfx-site-impact.test.mjs',
    'scripts/verify-kungfu-release-admission.mjs',
    'scripts/verify-kungfu-release-admission.test.mjs',
    'scripts/check-work-lifecycle-operation-matrix.test.mjs',
    'scripts/buildchain-kfd-evidence.mjs',
    '.buildchain/kfd/kfd-2/claims/agent-onboarding-pack.json',
    '.buildchain/kfd/kfd-3/collaboration-interface.artifact.json',
    '.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json',
    '.buildchain/kfd/kfd-3/surfaces.json',
    '.buildchain/kfd/support-matrix.json',
    'developer/sdk/kfd/kfd-2/claims/agent-onboarding-pack.json',
    'developer/sdk/kfd/kfd-2/release-claims.json',
    'developer/sdk/kfd/kfd-3-surfaces.json',
    'developer/sdk/kfd/support-matrix.json',
    'developer/sdk/kfd/upstream-aggregate.json',
    'developer/sdk/kfd/kfd-2/release-claims.json',
    'developer/sdk/kfd/kfd-2/claims/agent-onboarding-pack.json',
    'developer/sdk/kfd/kfd-2/claims/agent-work-state-contract.json',
    'developer/sdk/kfd/kfd-2/claims/codex-report-receipts.json',
    'developer/sdk/kfd/kfd-2/claims/cross-language-authority-membrane.json',
    'developer/sdk/kfd/kfd-2/claims/remote-fact-boundary.json',
    'developer/sdk/src/sdk.js',
    'developer/sdk/src/sdk-contract.js',
    'developer/sdk/src/sdk-kfd.js',
    'developer/sdk/src/sdk-shared.js',
    'extensions/work-control/work-control-actions/domain/work_control.py',
    'extensions/work-control/work-control-actions/domain/work_control_assessment.py',
    'extensions/work-control/work-control-actions/domain/work_control_runtime.py',
    'package.json',
    'framework/core/package.json',
    'pnpm-lock.yaml',
    'framework/release/buildchain-kfd-runtime.mjs',
    'framework/assignment-capture/qualified-assignment-core-consumer.mjs',
    'framework/assignment-capture/qualified-assignment-core-platform-matrix.mjs',
    'framework/release/qualified-assignment-core-artifact.mjs',
    'scripts/check-shifu-cache-contract.mjs',
    'scripts/check-shifu-cache-contract.test.mjs',
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
    'framework/core/src/python/kungfu/agent/__init__.py',
    'framework/core/src/python/kungfu/agent/bootstrap-receipt.schema.json',
    'framework/core/src/python/kungfu/agent/brief.md',
    'framework/core/src/python/kungfu/agent/commands.json',
    'framework/core/src/python/kungfu/agent/documentation.py',
    'framework/core/src/python/kungfu/agent/index.json',
    'framework/core/src/python/kungfu/agent/intent-map.json',
    'framework/core/src/python/kungfu/agent/kfd3_api.registry.json',
    'framework/core/src/python/kungfu/agent/resources.py',
    'framework/core/src/python/kungfu/agent/run_agent.py',
    'framework/core/src/python/kungfu/agent/skill-decision.contract.json',
    'framework/core/src/python/kungfu/agent/skills/amp/SKILL.md',
    'framework/core/src/python/kungfu/agent/skills/claude/SKILL.md',
    'framework/core/src/python/kungfu/agent/skills/codex/SKILL.md',
    'framework/core/src/python/kungfu/agent/skills/opencode/SKILL.md',
    'framework/core/src/python/kungfu/cli/commands/agent.py',
    'framework/core/src/python/kungfu/cli/commands/agent_work_lab.py',
    'framework/core/src/python/kungfu/cli/commands/assignment.py',
    'framework/core/src/python/kungfu/cli/surface_contract.py',
    'framework/core/tests/python/test_agent_first_entry.py',
    'framework/core/tests/python/test_agent_skill_advisory.py',
    'framework/core/tests/python/test_agent_work_state_contract.py',
    'framework/core/src/python/kungfu/cli/commands/exit.py',
    'framework/core/src/python/kungfu/cli/commands/env.py',
    'framework/core/src/python/kungfu/cli/commands/kfx.py',
    'framework/core/src/python/kungfu/cli/commands/kfx_authoring.py',
    'framework/core/src/python/kungfu/kfx_authoring/__init__.py',
    'framework/core/src/python/kungfu/kfx_authoring_assets/__init__.py',
    'framework/core/src/python/kungfu/kfx_authoring_assets/brief.md',
    'framework/core/src/python/kungfu/kfx_authoring_assets/contract.json',
    'framework/core/src/python/kungfu/kfx_authoring_assets/sdk/kfx-host.d.ts',
    'framework/core/src/python/kungfu/kfx_authoring_assets/sdk/sandbox-launcher.d.ts',
    'framework/core/src/python/kungfu/kfx_authoring_assets/sdk/service-authz.d.ts',
    'framework/core/src/python/kungfu/kfx_authoring_assets/sdk/service-webhook-host.mjs',
    'framework/core/src/python/kungfu/kfx_authoring_assets/sdk/types.d.ts',
    'framework/core/src/python/kungfu/kfx_authoring_assets/templates/webhook-service/README.md.tmpl',
    'framework/core/src/python/kungfu/kfx_authoring_assets/templates/webhook-service/fixtures/local-receiver.mjs',
    'framework/core/src/python/kungfu/kfx_authoring_assets/templates/webhook-service/kungfu.kfx.json.tmpl',
    'framework/core/src/python/kungfu/kfx_authoring_assets/templates/webhook-service/package.json.tmpl',
    'framework/core/src/python/kungfu/kfx_authoring_assets/templates/webhook-service/src/service.mjs.tmpl',
    'framework/core/src/python/kungfu/kfx_authoring_assets/templates/webhook-service/test/qualify.mjs.tmpl',
    'framework/core/tests/python/test_kfx_authoring.py',
    'docs/adr/KF-ADR-019fe996-1912-7144-8fa5-3fceaa416365.md',
    'docs/qualification/evidence/kungfu-temporal-provenance-cutover.json',
    'docs/qualification/evidence/kungfu-temporal-release-admission-facts.json',
    'docs/qualification/gates/release-admission.md',
    'docs/evolution/current-authority.md',
    'docs/evolution/document-metadata.registry.json',
    'docs/evolution/map.json',
    'docs/evolution/reader-routes.md',
    'docs/evolution/stages/11-temporal-relation-proof.md',
    'docs/evolution/timeline.md',
    'framework/contract/kungfu-contracts.registry.json',
    'framework/core/architecture/layered-api-encoding-boundary.contract.json',
    'framework/core/src/libkungfu/src/runtime/storage/fact_protocol.cpp',
    'framework/core/src/python/kungfu/storage/fact_root_canonical.py',
    'framework/core/src/python/kungfu/temporal_release_admission/__init__.py',
    'framework/core/tests/python/test_temporal_relation.py',
    'framework/core/tests/python/test_temporal_provenance_cutover.py',
    'framework/core/tests/python/test_temporal_release_admission.py',
    'framework/fact/kungfu-fact-cut-kernel.contract.json',
    'framework/fact/kungfu-fact-root-canonical-v2.json',
    'scripts/check-temporal-relation-contract.test.mjs',
    'scripts/temporal-provenance-cutover.py',
    'tests/fixtures/fact-root-canonical/vectors.json',
    'tests/fixtures/temporal-relation-contract/cases.json',
    'framework/core/src/python/kungfu/cli/commands/shifu.py',
    'framework/gui/src/renderer/src/main.tsx',
    'framework/gui/src/runtime-status.ts',
    'framework/maintainability/baseline-transitions/README.md',
    'framework/maintainability/code-complexity-policy.json',
    'framework/maintainability/code-complexity-baseline.json',
    'framework/maintainability/waivers/retired/hub-cli-linux-arm64-dist-platform-map.v1.json',
    'framework/maintainability/waivers/retired/hub-cli-linux-arm64-post-queue-workflow-authority.v1.json',
    'framework/maintainability/waivers/retired/hub-cli-linux-arm64-workflow-authority.v1.json',
    'framework/maintainability/waivers/retired/libnode-linux-arm64-lockfile.v1.json',
    'framework/maintainability/complexity-governance.mjs',
    'framework/maintainability/abstraction-integrity.manifest.json',
    'framework/maintainability/abstraction-integrity.baseline.json',
    'framework/maintainability/abstraction-integrity-report.json',
    'framework/report-projection/authority.json',
    'framework/maintainability/python-structure-negative-fixtures.json',
    'framework/maintainability/readonly-source-routes.json',
    'framework/maintainability/semantic-amplification.manifest.json',
    'framework/maintainability/semantic-amplification-report.json',
    'framework/maintainability/semantic-amplification.mjs',
    'framework/maintainability/semantic-amplification.test.mjs',
    'framework/report-projection/authority.mjs',
    'framework/report-projection/authority.test.mjs',
    'docs/qualification/evidence/generated-report-authority-queue/report.json',
    'docs/qualification/documentation-control-plane.receipt.json',
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
    'framework/work-design-policy-replay/schema/work-design-promotion-artifact-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-activation-envelope-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-feedback-inspection-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-feedback-status-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-outcome-compilation-request-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-outcome-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-policy-decision-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-policy-monitoring-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-policy-state-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-replay-policy-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-replay-report-v1.schema.json',
    'framework/work-design-policy-replay/schema/work-design-replay-request-v1.schema.json',
    'framework/work-design-policy-replay/src/work-design-policy-replay.mjs',
    'framework/work-design-policy-replay/tooling/check-work-design-policy-replay.mjs',
    'framework/work-design-policy-replay/tooling/work-design-policy-replay-contract.mjs',
    'framework/work-design-policy-replay/work-design-policy-replay.contract.json',
    'framework/work-design-preflight/src/work-design-preflight.mjs',
    'framework/work-design-preflight/tooling/check-work-design-preflight.mjs',
    'framework/work-design-preflight/tooling/work-design-preflight.mjs',
    'framework/work-design-preflight/work-design-preflight.contract.json',
  ])
    copyFile(ROOT, fixture, relative);
  const impactProofDirectory = path.join(
    ROOT,
    'framework/site/src/kfx-site-impact-proofs',
  );
  if (fs.existsSync(impactProofDirectory)) {
    for (const entry of fs
      .readdirSync(impactProofDirectory, { withFileTypes: true })
      .filter((value) => value.isFile() && value.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const proofRelative = `framework/site/src/kfx-site-impact-proofs/${entry.name}`;
      const proofBytes = fs.readFileSync(path.join(ROOT, proofRelative));
      const committedProof = spawnSync(
        git,
        ['-C', ROOT, 'show', `${exactSourceSha}:${proofRelative}`],
        { encoding: null },
      );
      if (
        committedProof.status !== 0 ||
        !proofBytes.equals(Buffer.from(committedProof.stdout || ''))
      ) {
        const proof = JSON.parse(proofBytes.toString('utf8'));
        for (const change of proof.changes || []) {
          const relative = String(change.path || '');
          assert.equal(path.isAbsolute(relative), false);
          assert.equal(relative.split(/[\\/]/u).includes('..'), false);
          const target = path.join(fixture, relative);
          if (change.status === 'deleted') {
            fs.rmSync(target, { force: true });
          } else {
            copyFile(ROOT, fixture, relative);
          }
        }
      }
      copyFile(ROOT, fixture, proofRelative);
    }
  }
  fs.rmSync(
    path.join(fixture, 'framework/core/src/python/kungfu/release_cut.py'),
    { force: true },
  );
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
  const workProfileConformanceManifest = JSON.parse(
    fs.readFileSync(
      path.join(
        ROOT,
        'framework',
        'work-profile-conformance',
        'authority-manifest.json',
      ),
      'utf8',
    ),
  );
  for (const relative of workProfileConformanceFixturePaths(
    workProfileConformanceManifest,
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
  for (const relative of [
    'node_modules/@kungfu-tech/kfd/package.json',
    'node_modules/@kungfu-tech/kfd/standards.json',
    'node_modules/@kungfu-tech/kfd/kfd.release.json',
    'node_modules/@kungfu-tech/buildchain/package.json',
    'node_modules/@kungfu-tech/buildchain/dist/site/buildchain-contract.json',
    'node_modules/@kungfu-tech/buildchain/dist/site/publication-authority-registry.json',
  ])
    copyFile(ROOT, fixture, relative);
  fs.chmodSync(path.join(fixture, 'shifu'), 0o755);

  fs.symlinkSync(git, path.join(tools, 'git'));
  fs.symlinkSync(node, path.join(tools, 'node'));
  fs.symlinkSync(executableOnPath('python3'), path.join(tools, 'python3'));
  for (const [name, relative] of [
    ['ruff', 'framework/core/.venv/bin/ruff'],
    ['mypy', 'framework/core/.venv/bin/mypy'],
  ]) {
    const projectExecutable = path.join(ROOT, relative);
    const executable = fs.existsSync(projectExecutable)
      ? projectExecutable
      : executableOnPath(name);
    fs.symlinkSync(executable, path.join(tools, name));
  }
  fs.symlinkSync(
    pinnedClangFormatExecutable(),
    path.join(tools, 'clang-format'),
  );
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
  const beforeAuditRoot = sourceAuditRoot(before);
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
    PYTHONDONTWRITEBYTECODE: '1',
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
  env.NODE_TEST_CONTEXT = undefined;
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
  restoreWritable(fixture);
  fs.chmodSync(path.join(fixture, 'shifu'), 0o755);
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
    `check:source (bounded tail):\n${boundedDiagnosticTail(
      sourceAcceptance.stderr,
      sourceAcceptance.stdout,
    )}`,
  );
  const after = snapshotSource(fixture);
  const afterAuditRoot = sourceAuditRoot(after);
  assert.deepEqual(after, before);
  assert.equal(afterAuditRoot, beforeAuditRoot);
  console.log(
    `[readonly-source] filesystem-write-audit before=${beforeAuditRoot} after=${afterAuditRoot} byteUnchanged=true`,
  );
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
