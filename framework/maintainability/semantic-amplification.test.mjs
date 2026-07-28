// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import {
  buildReport,
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
const clone = (value) => JSON.parse(JSON.stringify(value));

test('current semantic amplification projection has one route per family', () => {
  const report = buildReport(manifest, layers);
  assert.equal(report.verdict, 'pass');
  assert.equal(report.summary.families, 6);
  assert.equal(report.summary.authorities, 6);
  assert.equal(report.summary.mappedSurfaces, 77);
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

test('unknown production state fails without inflating another envelope', () => {
  const broken = clone(manifest);
  broken.productionBoundaries[2].state = 'probably-green';
  const issues = validateManifest(broken, layers, new Set());
  assert.ok(issues.some((item) => item.code === 'unknown-production-state'));
});
