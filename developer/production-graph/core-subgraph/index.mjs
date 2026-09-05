// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canonicalJson,
  fileRoot,
  loadFixture,
  rooted,
  schemaValidators,
  semanticRoot,
} from '../contract.mjs';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const CONTRACT_PATH = 'docs/shifu/core-production-subgraph-contract.json';
const FIXTURE_ROOT =
  'docs/shifu/examples/production-graph/core-production-subgraph';
const INVALID_FIXTURE_ROOT = `${FIXTURE_ROOT}/invalid`;
const TOOLCHAIN_PATHS = Object.freeze([
  'package.json',
  'framework/core/package.json',
  'framework/core/.gyp/run-build.js',
  'framework/core/.gyp/run-conan.js',
  'framework/core/.gyp/run-link-node.js',
  'framework/core/.gyp/gen-stubs.js',
  'framework/core/.gyp/run-wheel.js',
  'developer/production-graph/core-subgraph/stage-executor/index.mjs',
]);
const AUTHORITY_PATHS = Object.freeze({
  layers: 'framework/core/architecture/layers.json',
  buildCapabilities: 'framework/core/architecture/build-capabilities.json',
});
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export class CoreProductionSubgraphCompileError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'CoreProductionSubgraphCompileError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CoreProductionSubgraphCompileError(code, message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid-input', `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join('\0') !== wanted.join('\0')) {
    fail(
      'unknown-or-missing-field',
      `${label} fields must be exactly ${wanted.join(', ')}`,
    );
  }
}

function requireRoot(value, label) {
  if (!ROOT_PATTERN.test(value || '')) {
    fail('invalid-root', `${label} must be a sha256 root`);
  }
}

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixtureFiles(relativeRoot) {
  return fs
    .readdirSync(path.join(ROOT, relativeRoot))
    .filter((name) => name.endsWith('.fixture.json'))
    .sort()
    .map((name) => `${relativeRoot}/${name}`);
}

export function loadCoreProductionSubgraphContract(root = ROOT) {
  return loadFixture(root, CONTRACT_PATH);
}

export function coreProductionSubgraphContractRoot(root = ROOT) {
  return semanticRoot(loadCoreProductionSubgraphContract(root));
}

export function observeCoreProductionBindings(root = ROOT) {
  const source = {
    repository: 'https://github.com/kungfu-systems/kungfu.git',
    revision: git(root, 'rev-parse', 'HEAD'),
    tree: git(root, 'rev-parse', 'HEAD^{tree}'),
  };
  const layersRoot = fileRoot(path.join(root, AUTHORITY_PATHS.layers));
  const buildCapabilitiesRoot = fileRoot(
    path.join(root, AUTHORITY_PATHS.buildCapabilities),
  );
  const capabilities = loadFixture(root, AUTHORITY_PATHS.buildCapabilities);
  const profile = capabilities.profiles.find(({ id }) => id === 'journal');
  if (!profile || profile.status !== 'supported') {
    fail('profile-authority-mismatch', 'journal profile is not supported');
  }
  return {
    source: { ...source, root: semanticRoot(source) },
    buildProfile: { id: profile.id, root: semanticRoot(profile) },
    toolchainRoot: semanticRoot(
      TOOLCHAIN_PATHS.map((relative) => ({
        path: relative,
        root: fileRoot(path.join(root, relative)),
      })),
    ),
    layersRoot,
    buildCapabilitiesRoot,
    projectAuthorityRoot: semanticRoot({
      layersRoot,
      buildCapabilitiesRoot,
    }),
  };
}

function outputRoot(subgraphId, nodeId, outputId, bindings, sourceRoot) {
  return semanticRoot({
    schema: 'shifu.core-production-stage-output-declaration/v0',
    subgraphId,
    nodeId,
    outputId,
    sourceRoot,
    buildProfileRoot: bindings.buildProfile.root,
    toolchainRoot: bindings.toolchainRoot,
    projectAuthorityRoot: bindings.projectAuthorityRoot,
    xinfaSelectionRoot: bindings.xinfaSelectionRoot,
  });
}

function baseInputs(request) {
  return [
    { id: 'source', kind: 'source', root: request.source.root },
    {
      id: 'toolchain',
      kind: 'toolchain',
      root: request.bindings.toolchainRoot,
    },
    {
      id: 'build-profile',
      kind: 'build-profile',
      root: request.bindings.buildProfile.root,
    },
    {
      id: 'project-authority',
      kind: 'authority',
      root: request.bindings.projectAuthorityRoot,
    },
    {
      id: 'xinfa-selection',
      kind: 'semantic-selection',
      root: request.bindings.xinfaSelectionRoot,
    },
  ];
}

function expectedStages(request, contract) {
  const outputs = new Map();
  const stages = [];
  for (const stage of contract.stages) {
    const output = {
      id: stage.output,
      kind: 'stage-output',
      root: outputRoot(
        request.subgraphId,
        stage.id,
        stage.output,
        request.bindings,
        request.source.root,
      ),
    };
    outputs.set(stage.output, output);
    stages.push({
      id: stage.id,
      responsibility: stage.responsibility,
      dependencies: [...stage.dependencies],
      inputs: stage.requiredInputs
        .map((id) => {
          const reference =
            baseInputs(request).find((input) => input.id === id) ||
            outputs.get(id);
          return { ...reference };
        })
        .sort((left, right) => left.id.localeCompare(right.id)),
      outputs: [output],
    });
  }
  return stages;
}

export function createCoreProductionSubgraphRequest(
  {
    subgraphId = 'kungfu-core-journal-production',
    xinfaSelectionRoot,
    xinfaVerificationRoot,
  },
  { root = ROOT, observed = observeCoreProductionBindings(root) } = {},
) {
  requireRoot(xinfaSelectionRoot, 'xinfaSelectionRoot');
  requireRoot(xinfaVerificationRoot, 'xinfaVerificationRoot');
  const request = {
    schema: 'shifu.core-production-subgraph-compile-request/v0',
    subgraphId,
    source: observed.source,
    bindings: {
      buildProfile: observed.buildProfile,
      toolchainRoot: observed.toolchainRoot,
      layersRoot: observed.layersRoot,
      buildCapabilitiesRoot: observed.buildCapabilitiesRoot,
      projectAuthorityRoot: observed.projectAuthorityRoot,
      xinfaSelectionRoot,
    },
    xinfaVerification: {
      owner: 'xinfa',
      status: 'verified',
      sourceRevision: observed.source.revision,
      selectionRoot: xinfaSelectionRoot,
      verificationRoot: xinfaVerificationRoot,
    },
    stages: [],
  };
  request.stages = expectedStages(
    request,
    loadCoreProductionSubgraphContract(root),
  );
  return request;
}

function normalizeIdentity(identity) {
  exactKeys(identity, ['id', 'kind', 'root'], `identity.${identity?.id}`);
  requireRoot(identity.root, `identity.${identity.id}.root`);
  return { id: identity.id, kind: identity.kind, root: identity.root };
}

function normalizeStage(stage) {
  exactKeys(
    stage,
    ['dependencies', 'id', 'inputs', 'outputs', 'responsibility'],
    `stage.${stage?.id}`,
  );
  return {
    id: stage.id,
    responsibility: stage.responsibility,
    dependencies: [...stage.dependencies].sort(),
    inputs: stage.inputs
      .map(normalizeIdentity)
      .sort((left, right) => left.id.localeCompare(right.id)),
    outputs: stage.outputs
      .map(normalizeIdentity)
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function verifyObservedBindings(request, observed) {
  const expectedSourceRoot = semanticRoot({
    repository: request.source.repository,
    revision: request.source.revision,
    tree: request.source.tree,
  });
  if (request.source.root !== expectedSourceRoot) {
    fail(
      'source-root-mismatch',
      'source root does not bind source coordinates',
    );
  }
  for (const field of ['repository', 'revision', 'tree', 'root']) {
    if (request.source[field] !== observed.source[field]) {
      fail('source-drift', `${field} differs from the observed source`);
    }
  }
  for (const field of [
    'toolchainRoot',
    'layersRoot',
    'buildCapabilitiesRoot',
    'projectAuthorityRoot',
  ]) {
    requireRoot(request.bindings[field], `bindings.${field}`);
    if (request.bindings[field] !== observed[field]) {
      fail('authority-root-drift', `${field} differs from observed authority`);
    }
  }
  if (
    request.bindings.buildProfile.id !== observed.buildProfile.id ||
    request.bindings.buildProfile.root !== observed.buildProfile.root
  ) {
    fail('profile-authority-mismatch', 'build profile authority drifted');
  }
}

function verifyXinfa(request) {
  const verification = request.xinfaVerification;
  if (verification.owner !== 'xinfa' || verification.status !== 'verified') {
    fail('xinfa-selection-unverified', 'Xinfa selection is not verified');
  }
  if (verification.sourceRevision !== request.source.revision) {
    fail('xinfa-selection-stale', 'Xinfa selection source revision drifted');
  }
  if (verification.selectionRoot !== request.bindings.xinfaSelectionRoot) {
    fail('xinfa-selection-root-mismatch', 'Xinfa selection roots differ');
  }
}

function verifyStages(actual, expected) {
  const byId = new Map(actual.map((stage) => [stage.id, stage]));
  if (
    byId.size !== expected.length ||
    expected.some((stage) => !byId.has(stage.id))
  ) {
    fail('stage-set-mismatch', 'stage set must match the contract exactly');
  }
  for (const wanted of expected) {
    const observed = byId.get(wanted.id);
    if (observed.responsibility !== wanted.responsibility) {
      fail(
        'responsibility-mismatch',
        `${wanted.id} must own exactly ${wanted.responsibility}`,
      );
    }
    if (
      canonicalJson(observed.dependencies) !==
      canonicalJson(wanted.dependencies)
    ) {
      fail('dependency-order-mismatch', `${wanted.id} dependency edge drifted`);
    }
    if (canonicalJson(observed.inputs) !== canonicalJson(wanted.inputs)) {
      fail('input-root-mismatch', `${wanted.id} input binding drifted`);
    }
    if (canonicalJson(observed.outputs) !== canonicalJson(wanted.outputs)) {
      fail('output-root-mismatch', `${wanted.id} output declaration drifted`);
    }
  }
}

export async function compileCoreProductionSubgraph(
  request,
  {
    root = ROOT,
    observed = observeCoreProductionBindings(root),
    validators = null,
  } = {},
) {
  exactKeys(
    request,
    [
      'bindings',
      'schema',
      'source',
      'stages',
      'subgraphId',
      'xinfaVerification',
    ],
    'request',
  );
  if (request.schema !== 'shifu.core-production-subgraph-compile-request/v0') {
    fail('unsupported-schema', 'compile request schema is unsupported');
  }
  const checks = validators || (await schemaValidators(root));
  if (!checks.coreProductionSubgraphCompileRequest(request)) {
    fail(
      'schema-invalid',
      JSON.stringify(checks.coreProductionSubgraphCompileRequest.errors || []),
    );
  }
  verifyObservedBindings(request, observed);
  verifyXinfa(request);
  const contract = loadCoreProductionSubgraphContract(root);
  const stages = request.stages.map(normalizeStage);
  const expected = expectedStages(request, contract);
  verifyStages(stages, expected);

  const subgraph = rooted(
    {
      schema: 'shifu.core-production-subgraph/v0',
      subgraphId: request.subgraphId,
      contractRoot: coreProductionSubgraphContractRoot(root),
      source: request.source,
      bindings: request.bindings,
      intent: { mode: 'describe-only', sideEffects: false },
      executionBoundary: contract.executionBoundary,
      nodes: expected,
    },
    'subgraphRoot',
  );
  const plan = rooted(
    {
      schema: 'shifu.core-production-subgraph-plan/v0',
      contractRoot: subgraph.contractRoot,
      subgraphRoot: subgraph.subgraphRoot,
      sourceRevision: subgraph.source.revision,
      bindings: subgraph.bindings,
      orderedNodeIds: expected.map(({ id }) => id),
      steps: expected.map((node, index) => ({
        index,
        nodeId: node.id,
        dependsOn: node.dependencies,
        inputIds: node.inputs.map(({ id }) => id),
        outputIds: node.outputs.map(({ id }) => id),
        directlyInvocable: false,
      })),
      executionBoundary: contract.executionBoundary,
    },
    'planRoot',
  );
  for (const [label, validate, document] of [
    ['subgraph', checks.coreProductionSubgraph, subgraph],
    ['plan', checks.coreProductionSubgraphPlan, plan],
  ]) {
    if (!validate(document)) {
      fail(
        'schema-invalid',
        `${label}: ${JSON.stringify(validate.errors || [])}`,
      );
    }
  }
  return { subgraph, plan };
}

export function authoritativeBuildCoreRoute(root = ROOT) {
  const project = loadFixture(root, 'package.json');
  const core = loadFixture(root, 'framework/core/package.json');
  const route = {
    command: ['./shifu', 'build:core'],
    projectScript: project.scripts['build:core'],
    coreBuildScript: core.scripts.build,
    implementationRoot: fileRoot(
      path.join(root, 'framework/core/.gyp/run-build.js'),
    ),
  };
  if (
    route.projectScript !==
      'node scripts/require-shifu.mjs build:core && pnpm --filter @kungfu-tech/core run build' ||
    route.coreBuildScript !== 'node .gyp/run-build.js build'
  ) {
    fail('build-core-route-drift', 'authoritative build:core route changed');
  }
  return rooted(route, 'routeRoot');
}

function applyMutation(request, mutation) {
  const changed = structuredClone(request);
  let parent = changed;
  for (const key of mutation.path.slice(0, -1)) parent = parent[key];
  const key = mutation.path.at(-1);
  if (mutation.operation === 'delete') delete parent[key];
  else parent[key] = structuredClone(mutation.value);
  return changed;
}

export async function checkCoreProductionSubgraphContract({
  root = ROOT,
  validators = null,
} = {}) {
  const checks = validators || (await schemaValidators(root));
  const validFiles = fixtureFiles(FIXTURE_ROOT);
  const invalidFiles = fixtureFiles(INVALID_FIXTURE_ROOT);
  if (validFiles.length < 1 || invalidFiles.length < 5) {
    throw new Error('Core Production Subgraph fixture set is incomplete');
  }
  const observed = observeCoreProductionBindings(root);
  const validFixtureRoots = [];
  let qualified = null;
  for (const relative of validFiles) {
    const fixture = loadFixture(root, relative);
    const request = createCoreProductionSubgraphRequest(fixture, {
      root,
      observed,
    });
    const compiled = await compileCoreProductionSubgraph(request, {
      root,
      observed,
      validators: checks,
    });
    validFixtureRoots.push(
      semanticRoot({
        fixtureRoot: fileRoot(path.join(root, relative)),
        subgraphRoot: compiled.subgraph.subgraphRoot,
        planRoot: compiled.plan.planRoot,
      }),
    );
    qualified = compiled;
  }
  const invalidFixtureRoots = [];
  const baseFixture = loadFixture(root, validFiles[0]);
  const baseRequest = createCoreProductionSubgraphRequest(baseFixture, {
    root,
    observed,
  });
  for (const relative of invalidFiles) {
    const fixture = loadFixture(root, relative);
    const request = applyMutation(baseRequest, fixture.mutation);
    try {
      await compileCoreProductionSubgraph(request, {
        root,
        observed,
        validators: checks,
      });
      throw new Error(`${relative}: invalid fixture compiled`);
    } catch (error) {
      if (error?.code !== fixture.expect) {
        throw new Error(
          `${relative}: expected ${fixture.expect}, got ${error?.code || error?.message}`,
          { cause: error },
        );
      }
    }
    invalidFixtureRoots.push(
      semanticRoot({
        fixtureRoot: fileRoot(path.join(root, relative)),
        expectedCode: fixture.expect,
      }),
    );
  }
  const contract = loadCoreProductionSubgraphContract(root);
  const route = authoritativeBuildCoreRoute(root);
  const receipt = rooted(
    {
      schema: 'shifu.core-production-subgraph-verification-receipt/v0',
      status: 'qualified',
      sourceRevision: observed.source.revision,
      sourceTree: observed.source.tree,
      contractRoot: coreProductionSubgraphContractRoot(root),
      schemaRoots: Object.fromEntries(
        Object.entries(contract.schemas).map(([kind, relative]) => [
          kind,
          fileRoot(path.join(root, relative)),
        ]),
      ),
      compilerRoot: fileRoot(
        path.join(root, 'developer/production-graph/core-subgraph/index.mjs'),
      ),
      subgraphRoot: qualified.subgraph.subgraphRoot,
      planRoot: qualified.plan.planRoot,
      authoritativeRouteRoot: route.routeRoot,
      validFixtureRoots,
      invalidFixtureRoots,
      validFixtureCount: validFiles.length,
      invalidFixtureCount: invalidFiles.length,
      protectedGate: './shifu check:source',
      nodesExecuted: false,
      currentRouteUnchanged: true,
    },
    'receiptRoot',
  );
  if (!checks.coreProductionSubgraphVerificationReceipt(receipt)) {
    throw new Error(
      `Core Production Subgraph receipt schema invalid: ${JSON.stringify(checks.coreProductionSubgraphVerificationReceipt.errors || [])}`,
    );
  }
  return receipt;
}

export { AUTHORITY_PATHS, CONTRACT_PATH, TOOLCHAIN_PATHS };
