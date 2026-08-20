// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import {
  baselineChangedPaths,
  buildReport,
  evaluateIntegrity,
  queryTaskGraph,
  validateManifest,
} from './semantic-amplification.mjs';

const manifest = JSON.parse(
  fs.readFileSync(
    new URL('./semantic-amplification.manifest.json', import.meta.url),
    'utf8',
  ),
);
const layers = JSON.parse(
  fs.readFileSync(
    new URL('../core/architecture/layers.json', import.meta.url),
    'utf8',
  ),
);
const terminalMatrix = JSON.parse(
  fs.readFileSync(
    new URL('./terminal-evidence-matrix.json', import.meta.url),
    'utf8',
  ),
);
const integrityFixtures = JSON.parse(
  fs.readFileSync(
    new URL('./semantic-amplification.fixtures.json', import.meta.url),
    'utf8',
  ),
);
const clone = (value) => JSON.parse(JSON.stringify(value));

test('baseline changed paths conserve tree, worktree, and untracked inputs without rename reads', () => {
  const calls = [];
  const changed = baselineChangedPaths('protected-base', (args) => {
    calls.push(args);
    if (args[0] === 'ls-files') return ['untracked-only.cpp', 'shared-path.ts'];
    if (args.includes('protected-base'))
      return ['tree-only.py', 'shared-path.ts'];
    return ['worktree-only.rs', 'shared-path.ts'];
  });

  assert.deepEqual(calls, [
    ['diff', '--no-renames', '--name-only', 'protected-base', 'HEAD', '--'],
    ['diff', '--no-renames', '--name-only', 'HEAD', '--'],
    ['ls-files', '--others', '--exclude-standard'],
  ]);
  assert.deepEqual([...changed].sort(), [
    'shared-path.ts',
    'tree-only.py',
    'untracked-only.cpp',
    'worktree-only.rs',
  ]);
});

test('current semantic amplification projection has one route per family', () => {
  const report = buildReport(manifest, layers);
  assert.equal(report.verdict, 'pass');
  assert.equal(report.summary.families, 6);
  assert.equal(report.summary.authorities, 6);
  assert.equal(report.summary.mappedSurfaces, 88);
  assert.equal(
    report.integrity.schema,
    'kungfu.abstraction-integrity-report/v1',
  );
  assert.equal(report.integrity.metrics.topologies, 5);
  assert.equal(report.integrity.metrics.findings, 0);
  assert.equal(report.integrity.metrics.weightedDebt, 0);
  assert.equal(report.integrity.baselineComparison.findingDelta, -3);
  assert.equal(report.integrity.baselineComparison.weightedDebtDelta, -18);
  assert.equal(report.integrity.baselineComparison.ratchet, 'pass');
  assert.deepEqual(report.issues, []);
});

test('missing authority and unknown projection role fail closed', () => {
  const broken = clone(manifest);
  broken.families[0].authority.sources = [];
  broken.families[1].surfaces[0].role = 'shadow-authority';
  const issues = validateManifest(broken, layers, new Set());
  assert.ok(issues.some((item) => item.code === 'missing-authority'));
  assert.ok(issues.some((item) => item.code === 'unknown-role'));
});

test('changed semantic identity outside the declared graph is blocking', () => {
  const broken = clone(manifest);
  broken.families[0].discoveryRoots = ['framework/maintainability/'];
  broken.families[0].identityTokens = [
    'kungfu.semantic-amplification-report/v1',
  ];
  const issues = validateManifest(
    broken,
    layers,
    new Set(['framework/maintainability/semantic-amplification.mjs']),
  );
  assert.ok(issues.some((item) => item.code === 'unmapped-semantic-surface'));
});

test('task graph resolves a path and returns authority-to-recovery closure', () => {
  const report = buildReport(manifest, layers);
  const graph = queryTaskGraph(
    report,
    manifest,
    'framework/core/src/libkungfu/src/runtime/storage/service.cpp',
    layers,
  );
  assert.equal(graph.verdict, 'pass');
  assert.equal(graph.owner, 'core/runtime-storage');
  assert.deepEqual(
    graph.families.map((family) => family.id),
    ['storage-query'],
  );
  assert.ok(graph.families[0].affectedTests.length > 0);
  assert.ok(graph.families[0].knownLimits.length > 0);
  assert.ok(graph.families[0].recovery);
});

test('integrity task graph resolves a declared durability adapter', () => {
  const report = buildReport(manifest, layers);
  const graph = queryTaskGraph(
    report,
    manifest,
    'framework/core/src/libkungfu/src/runtime/durable_ingest.cpp',
    layers,
  );
  assert.equal(graph.verdict, 'pass');
  assert.deepEqual(
    graph.integrityTopologies.map((topology) => topology.id),
    ['core-durability'],
  );
  assert.ok(
    graph.integrityTopologies[0].adapters.some(
      (adapter) => adapter.id === 'native-file-durability-platform-adapter',
    ),
  );
  assert.deepEqual(graph.integrityTopologies[0].findings, []);
});

test('task graph explains legal runner variants without making a second authority', () => {
  const report = buildReport(manifest, layers);
  const graph = queryTaskGraph(report, manifest, 'execution-topology', layers);
  assert.equal(graph.verdict, 'pass');
  const runner = graph.integrityTopologies.find(
    (topology) => topology.id === 'runner-lifecycle',
  );
  assert.equal(runner.authority.kind, 'external-pinned-contract');
  assert.ok(runner.legalAxes.lifecycle.includes('jit'));
  assert.ok(
    runner.adapters.some((adapter) => adapter.id === 'aws-ec2-windows-jit'),
  );
});

test('synthetic provider variant stays legal when it binds the existing authority', () => {
  const policy = clone(manifest.integrityPolicy);
  const runner = policy.topologies.find(
    (topology) => topology.id === 'runner-lifecycle',
  );
  runner.adapters.push(clone(integrityFixtures.syntheticProviderVariant));
  const original = evaluateIntegrity(manifest.integrityPolicy);
  const synthetic = evaluateIntegrity(policy);
  assert.equal(synthetic.metrics.findings, original.metrics.findings);
  assert.equal(synthetic.metrics.adapters, original.metrics.adapters + 1);
  assert.ok(
    !synthetic.findings.some(
      (finding) => finding.target === 'synthetic-linux-jit',
    ),
  );
});

test('adversarial integrity fixtures classify fragmentation independently', () => {
  for (const fixture of integrityFixtures.adversarial) {
    const policy = clone(manifest.integrityPolicy);
    const runner = policy.topologies.find(
      (topology) => topology.id === 'runner-lifecycle',
    );
    if (fixture.mutation === 'additional-authority') {
      runner.additionalAuthorities = [{ id: 'shadow-runner-registry' }];
    } else if (fixture.mutation === 'duplicate-adapter') {
      runner.adapters.push({
        ...clone(runner.adapters[0]),
        id: 'copied-hosted-policy',
      });
    } else if (fixture.mutation === 'token-spread') {
      const product = policy.topologies.find(
        (topology) => topology.id === 'product-assembly',
      );
      product.detectors.push({
        id: 'fixture-platform-leak',
        kind: 'token-spread',
        findingClass: 'leaking-platform-branch',
        paths: [
          'framework/core/src/libkungfu/src/runtime/durable_ingest.cpp',
          'framework/core/src/libkungfu/src/runtime/storage/backend_switch.cpp',
        ],
        tokens: ['::fsync'],
        maximumPaths: 1,
      });
    } else if (fixture.mutation === 'remove-authority-binding') {
      runner.adapters[0].authorityBinding = '';
    } else if (fixture.mutation === 'expire-exception') {
      runner.exceptions[0].expiresAt = '2020-01-01';
    }
    const result = evaluateIntegrity(policy, {
      exists: (relative) =>
        fs.existsSync(new URL(`../../${relative}`, import.meta.url)),
      readText: (relative) => {
        if (
          fixture.mutation === 'token-spread' &&
          [
            'framework/core/src/libkungfu/src/runtime/durable_ingest.cpp',
            'framework/core/src/libkungfu/src/runtime/storage/backend_switch.cpp',
          ].includes(relative)
        ) {
          return 'synthetic platform branch uses ::fsync directly';
        }
        return fs.readFileSync(
          new URL(`../../${relative}`, import.meta.url),
          'utf8',
        );
      },
      now: () => new Date('2026-07-31T00:00:00Z'),
    });
    assert.ok(
      result.findings.some(
        (finding) => finding.class === fixture.expectedClass,
      ),
      fixture.id,
    );
  }
});

test('integrity ratchet blocks weighted debt regression', () => {
  const broken = clone(manifest);
  broken.integrityPolicy.ratchet.baseline.findings = 0;
  broken.integrityPolicy.ratchet.baseline.weightedDebt = 0;
  broken.integrityPolicy.ratchet.baseline.findingIds = [];
  const runner = broken.integrityPolicy.topologies.find(
    (topology) => topology.id === 'runner-lifecycle',
  );
  runner.additionalAuthorities = [{ id: 'shadow-runner-registry' }];
  const issues = validateManifest(broken, layers, new Set());
  assert.ok(
    issues.some((item) => item.code === 'integrity-ratchet-regression'),
  );
});

test('unknown production state fails without inflating another envelope', () => {
  const broken = clone(manifest);
  broken.productionBoundaries[2].state = 'probably-green';
  const issues = validateManifest(broken, layers, new Set());
  assert.ok(issues.some((item) => item.code === 'unknown-production-state'));
});

test('sealed Assignment state and Agent-facing projection cannot diverge', () => {
  const staleProjection = clone(manifest);
  staleProjection.productionBoundaries[2].state = 'retained-dependency';
  let issues = validateManifest(
    staleProjection,
    layers,
    new Set(),
    terminalMatrix,
  );
  assert.ok(
    issues.some(
      (item) => item.code === 'closed-assignment-projection-conflict',
    ),
  );

  const reopenedNativeState = clone(terminalMatrix);
  reopenedNativeState.rows[0].disposition = 'active';
  issues = validateManifest(manifest, layers, new Set(), reopenedNativeState);
  assert.ok(
    issues.some(
      (item) => item.code === 'projected-closure-without-native-evidence',
    ),
  );

  const mixedRoots = clone(manifest);
  mixedRoots.productionBoundaries[2].dependentAssignment.requestRoot =
    'sha256:'.concat('0'.repeat(64));
  issues = validateManifest(mixedRoots, layers, new Set(), terminalMatrix);
  assert.ok(
    issues.some((item) => item.code === 'terminal-assignment-root-conflict'),
  );
});
