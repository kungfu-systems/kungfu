#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HARNESS_DIR, '..', '..', '..');
const DEFAULT_MATRIX = path.join(HARNESS_DIR, 'artifact-matrix.json');
const DEFAULT_SCHEMA = path.join(
  HARNESS_DIR,
  'schemas',
  'artifact-matrix-v1.schema.json',
);
const EXPECTED_STATUSES = [
  'absent',
  'staged',
  'passing',
  'failing',
  'unverifiable',
];
const EXPECTED_BUDGETS = [
  'dependency_count',
  'installed_size_bytes',
  'cold_start_ms',
  'resident_runtime_count',
  'resident_memory_bytes',
  'onboarding_concept_count',
];
const EXPECTED_ARTIFACTS = [
  'format-spec',
  'libkungfu',
  'pypi-sdk',
  'npm-sdk',
  'cargo-sdk',
  'cli-tui',
  'gui',
  'assembled-distribution',
];
const WORKSPACE_ROOTS = [
  'framework',
  'developer',
  'extensions',
  'examples',
  'product',
];

function usage() {
  console.log(`KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff Layer Qualification Harness

Usage:
  ./shifu layers:qualify -- [--matrix PATH] [--report PATH]

The command validates the declarative artifact matrix, records source-level
budget baselines, and runs deletion fixtures. A passing harness does not turn
staged or absent artifact rows into qualified release claims.`);
}

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  const result = { matrix: DEFAULT_MATRIX, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg === '--matrix' || arg === '--report') {
      index += 1;
      if (index >= argv.length) fail(`${arg} requires a path`);
      result[arg.slice(2)] = path.resolve(argv[index]);
      continue;
    }
    fail(`unknown argument '${arg}'`);
  }
  return result;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(
      `cannot read JSON ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validateSchemaContract(schema) {
  if (
    schema.properties?.schema?.const !== 'kungfu.layer-qualification.matrix/v1'
  ) {
    fail('artifact matrix schema has an unexpected contract id');
  }
  if (
    JSON.stringify(schema.properties?.status_vocabulary?.const) !==
    JSON.stringify(EXPECTED_STATUSES)
  ) {
    fail('artifact matrix schema status vocabulary drifted from the runner');
  }
  if (
    JSON.stringify(schema.properties?.budget_dimensions?.const) !==
    JSON.stringify(EXPECTED_BUDGETS)
  ) {
    fail('artifact matrix schema budget dimensions drifted from the runner');
  }
}

function assertUniqueStrings(value, label, allowEmpty = true) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  if (value.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail(`${label} must contain non-empty strings`);
  }
  if (new Set(value).size !== value.length) fail(`${label} must be unique`);
}

function validateMatrix(matrix) {
  if (matrix.schema !== 'kungfu.layer-qualification.matrix/v1') {
    fail(`unsupported matrix schema '${matrix.schema}'`);
  }
  if (
    JSON.stringify(matrix.status_vocabulary) !==
    JSON.stringify(EXPECTED_STATUSES)
  ) {
    fail('status_vocabulary must preserve the KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff five-state order');
  }
  if (
    JSON.stringify(matrix.budget_dimensions) !==
    JSON.stringify(EXPECTED_BUDGETS)
  ) {
    fail('budget_dimensions must preserve the KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff baseline dimensions');
  }
  if (!Array.isArray(matrix.artifacts) || matrix.artifacts.length === 0) {
    fail('artifacts must be a non-empty array');
  }
  const ids = new Set();
  for (const artifact of matrix.artifacts) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(artifact.id || '')) {
      fail(`invalid artifact id '${artifact.id}'`);
    }
    if (ids.has(artifact.id)) fail(`duplicate artifact id '${artifact.id}'`);
    ids.add(artifact.id);
    if (!EXPECTED_STATUSES.includes(artifact.artifact_status)) {
      fail(`${artifact.id}.artifact_status is invalid`);
    }
    if (
      typeof artifact.declared_closure !== 'string' ||
      !artifact.declared_closure
    ) {
      fail(`${artifact.id}.declared_closure is required`);
    }
    assertUniqueStrings(
      artifact.required_capabilities,
      `${artifact.id}.required_capabilities`,
    );
    assertUniqueStrings(
      artifact.forbidden_dependencies,
      `${artifact.id}.forbidden_dependencies`,
    );
    assertUniqueStrings(
      artifact.onboarding?.commands,
      `${artifact.id}.onboarding.commands`,
    );
    assertUniqueStrings(
      artifact.onboarding?.concepts,
      `${artifact.id}.onboarding.concepts`,
    );
  }
  if (
    JSON.stringify([...ids].sort()) !==
    JSON.stringify([...EXPECTED_ARTIFACTS].sort())
  ) {
    fail(
      `artifact ids must exactly match the official KF-ADR-019f86da-4f90-7c91-9cc2-6dbd18d68dff set: ${EXPECTED_ARTIFACTS.join(', ')}`,
    );
  }
  if (
    !Array.isArray(matrix.deletion_fixtures) ||
    matrix.deletion_fixtures.length === 0
  ) {
    fail('deletion_fixtures must be a non-empty array');
  }
  for (const fixture of matrix.deletion_fixtures) {
    if (!ids.has(fixture.root_artifact)) {
      fail(`${fixture.id}.root_artifact '${fixture.root_artifact}' is unknown`);
    }
    assertUniqueStrings(
      fixture.removed_packages,
      `${fixture.id}.removed_packages`,
      false,
    );
    assertUniqueStrings(
      fixture.forbidden_external_dependencies,
      `${fixture.id}.forbidden_external_dependencies`,
    );
    if (typeof fixture.claim_boundary !== 'string' || !fixture.claim_boundary) {
      fail(`${fixture.id}.claim_boundary is required`);
    }
  }
}

function walkPackageJson(dir, result, sourceRoot) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      [
        'node_modules',
        '.venv',
        '.deps',
        'dist',
        'build',
        'out',
        'release',
      ].includes(entry.name)
    )
      continue;
    const target = path.join(dir, entry.name);
    if (
      path.resolve(target) === path.resolve(sourceRoot, 'product', 'extensions')
    )
      continue;
    if (entry.isDirectory()) walkPackageJson(target, result, sourceRoot);
    else if (entry.isFile() && entry.name === 'package.json')
      result.push(target);
  }
}

function loadWorkspaceGraph(root = ROOT) {
  const files = [];
  for (const rel of WORKSPACE_ROOTS)
    walkPackageJson(path.join(root, rel), files, root);
  const packages = new Map();
  for (const file of files) {
    const manifest = readJson(file);
    if (!manifest.name) continue;
    if (packages.has(manifest.name))
      fail(`duplicate workspace package '${manifest.name}'`);
    packages.set(manifest.name, {
      file,
      manifest,
      runtimeDependencies: {
        ...(manifest.dependencies || {}),
        ...(manifest.optionalDependencies || {}),
        ...(manifest.peerDependencies || {}),
      },
    });
  }
  return packages;
}

function runtimeClosure(graph, rootPackage) {
  if (!graph.has(rootPackage))
    fail(`workspace package '${rootPackage}' not found`);
  const seen = new Set();
  const external = new Set();
  const queue = [rootPackage];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const entry = graph.get(name);
    if (!entry) fail(`workspace package '${name}' disappeared from projection`);
    for (const dependency of Object.keys(entry.runtimeDependencies).sort()) {
      if (graph.has(dependency)) queue.push(dependency);
      else external.add(dependency);
    }
  }
  return {
    workspacePackages: [...seen].sort(),
    externalDependencies: [...external].sort(),
  };
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function writeProjection(graph, closure, removedPackages) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-layer-deletion-'));
  const manifests = path.join(root, 'framework');
  fs.mkdirSync(manifests, { recursive: true });
  for (const name of closure.workspacePackages) {
    if (removedPackages.includes(name)) continue;
    const safeName = name.replaceAll('@', '').replaceAll('/', '__');
    const dir = path.join(manifests, safeName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify(graph.get(name).manifest, null, 2)}\n`,
      'utf8',
    );
  }
  return root;
}

function runDeletionFixture(graph, fixture) {
  for (const removed of fixture.removed_packages) {
    if (!graph.has(removed))
      fail(
        `${fixture.id}: removed package '${removed}' is not present in the source graph`,
      );
  }
  const sourceClosure = runtimeClosure(graph, fixture.root_package);
  const forbiddenWorkspace = sourceClosure.workspacePackages.filter((name) =>
    fixture.removed_packages.includes(name),
  );
  const forbiddenExternal = sourceClosure.externalDependencies.filter((name) =>
    fixture.forbidden_external_dependencies.includes(name),
  );
  if (forbiddenWorkspace.length || forbiddenExternal.length) {
    fail(
      `${fixture.id}: source runtime closure reaches forbidden dependencies: ${[
        ...forbiddenWorkspace,
        ...forbiddenExternal,
      ].join(', ')}`,
    );
  }

  const projectionRoot = writeProjection(
    graph,
    sourceClosure,
    fixture.removed_packages,
  );
  try {
    const projectedGraph = loadWorkspaceGraph(projectionRoot);
    const projectedClosure = runtimeClosure(
      projectedGraph,
      fixture.root_package,
    );
    if (projectedClosure.workspacePackages.includes('@kungfu-tech/gui')) {
      fail(
        `${fixture.id}: projected closure unexpectedly contains @kungfu-tech/gui`,
      );
    }
    if (
      projectedClosure.workspacePackages.length !==
      sourceClosure.workspacePackages.length
    ) {
      fail(
        `${fixture.id}: deletion projection changed the headless workspace closure`,
      );
    }
    return {
      id: fixture.id,
      status: 'passing',
      root_package: fixture.root_package,
      removed_packages: fixture.removed_packages,
      workspace_packages: projectedClosure.workspacePackages,
      external_dependencies: projectedClosure.externalDependencies,
      claim_boundary: fixture.claim_boundary,
    };
  } finally {
    fs.rmSync(projectionRoot, { recursive: true, force: true });
  }
}

function baselineForArtifact(graph, artifact) {
  const measurements = {};
  if (artifact.workspace_package && graph.has(artifact.workspace_package)) {
    const closure = runtimeClosure(graph, artifact.workspace_package);
    const forbidden = [
      ...closure.workspacePackages,
      ...closure.externalDependencies,
    ].filter((name) => artifact.forbidden_dependencies.includes(name));
    if (forbidden.length > 0) {
      fail(
        `${artifact.id}: runtime dependency closure reaches forbidden dependencies: ${forbidden.join(', ')}`,
      );
    }
    measurements.dependency_count = {
      status: 'passing',
      value:
        closure.workspacePackages.length + closure.externalDependencies.length,
      unit: 'runtime dependencies including root package',
      workspace_packages: closure.workspacePackages,
      external_dependencies: closure.externalDependencies,
    };
  } else {
    measurements.dependency_count = {
      status: artifact.artifact_status === 'absent' ? 'absent' : 'unverifiable',
      value: null,
      unit: 'runtime dependencies including root package',
    };
  }
  for (const dimension of [
    'installed_size_bytes',
    'cold_start_ms',
    'resident_runtime_count',
    'resident_memory_bytes',
  ]) {
    measurements[dimension] = {
      status: artifact.artifact_status === 'absent' ? 'absent' : 'unverifiable',
      value: null,
      reason:
        'No exact installed artifact was supplied to this source-level harness run.',
    };
  }
  measurements.onboarding_concept_count = {
    status: 'passing',
    value: artifact.onboarding.concepts.length,
    unit: 'declared concepts',
    commands: artifact.onboarding.commands,
    concepts: artifact.onboarding.concepts,
  };
  return measurements;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const matrix = readJson(options.matrix);
  validateSchemaContract(readJson(DEFAULT_SCHEMA));
  validateMatrix(matrix);
  const graph = loadWorkspaceGraph();
  const fixtures = matrix.deletion_fixtures.map((fixture) =>
    runDeletionFixture(graph, fixture),
  );
  const artifactReports = matrix.artifacts.map((artifact) => ({
    id: artifact.id,
    artifact_status: artifact.artifact_status,
    declared_closure: artifact.declared_closure,
    measurements: baselineForArtifact(graph, artifact),
  }));
  const statusCounts = Object.fromEntries(
    EXPECTED_STATUSES.map((status) => [
      status,
      artifactReports.filter((artifact) => artifact.artifact_status === status)
        .length,
    ]),
  );
  const report = {
    schema: 'kungfu.layer-qualification.report/v1',
    harness_valid: true,
    matrix: path.relative(ROOT, options.matrix),
    matrix_sha256: sha256(options.matrix),
    matrix_schema: path.relative(ROOT, DEFAULT_SCHEMA),
    matrix_schema_sha256: sha256(DEFAULT_SCHEMA),
    source: {
      commit: git(['rev-parse', 'HEAD']),
      tree_dirty: git(['status', '--porcelain']).length > 0,
      platform: process.platform,
      architecture: process.arch,
      node: process.versions.node,
    },
    artifact_status_counts: statusCounts,
    artifacts: artifactReports,
    deletion_fixtures: fixtures,
    boundary:
      'harness_valid means the matrix and fixtures executed. It does not promote staged, absent, failing, or unverifiable artifacts to passing.',
  };
  if (options.report) {
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(
      options.report,
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
  }
  console.log(
    `[layers:qualify] matrix=${matrix.artifacts.length} artifacts; ` +
      `statuses=${EXPECTED_STATUSES.map((status) => `${status}:${statusCounts[status]}`).join(',')}; ` +
      `deletion=${fixtures.length}/${matrix.deletion_fixtures.length} passing`,
  );
  if (options.report) console.log(`[layers:qualify] report=${options.report}`);
  console.log(`[layers:qualify] ${report.boundary}`);
}

try {
  main();
} catch (error) {
  console.error(
    `[layers:qualify] failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
