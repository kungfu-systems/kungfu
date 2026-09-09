// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CATALOG_ARTIFACT,
  CATALOG_HEADER,
  CATALOG_SOURCE,
  buildPrimitiveCatalog,
  discoverPrimitiveArtifacts,
  expectedOutputs,
  findGhostArtifacts,
  primitiveArtifactClosureIssues,
  renderHeader,
  splitUtf8ForCppLiterals,
  verifyPrimitiveDefinition,
  verifyPrimitivePromotion,
} from './generate-primitive-catalog.mjs';
import {
  PRIMITIVE_CONTEXT_PARITY_GROUP,
  PRIMITIVE_CONTEXT_ROLE,
  PRIMITIVE_CONTEXT_ROUTE,
  primitiveContextBinding,
  primitiveScaffold,
  runPrimitiveAuthoring,
} from './new-primitive.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HASH = `sha256:${'1'.repeat(64)}`;
const STRICT_DEFINITION_ARGS = [
  '--family',
  'ordinary-capability',
  '--kind',
  'test-responsibility',
  '--boundary-participation',
  'responsibility',
  '--deletion-rationale',
  'Deletion removes the durable test responsibility.',
  '--substitution-rationale',
  'No existing Primitive carries this test responsibility.',
  '--compression-rationale',
  'Compression would fuse independent test responsibilities.',
];

function contextReceipt(id, overrides = {}) {
  const projection = {
    schema: 'xinfa.task-chart/v1',
    status: 'complete',
    atlas_root: HASH,
    cut_root: HASH,
    policy_root: HASH,
    projection_root: HASH,
    task: {
      route: PRIMITIVE_CONTEXT_ROUTE,
      role: PRIMITIVE_CONTEXT_ROLE,
      intent: `author Kungfu Primitive ${id} through the governed passport workflow`,
    },
    budget: { max_tokens: 48000, used_tokens: 1000 },
    omissions: [],
    units: [
      {
        id: 'primitive-authority',
        source: { path: 'CONTRIBUTING.md', content_root: HASH },
      },
    ],
    parity: {
      atlas_omissions: [],
      source_roots: { source: HASH, semantic: HASH, verification: HASH },
      route: {
        id: PRIMITIVE_CONTEXT_ROUTE,
        parity_group: PRIMITIVE_CONTEXT_PARITY_GROUP,
        status: 'current',
        route_root: HASH,
        authority_root: HASH,
      },
    },
    ...overrides,
  };
  return {
    schema: 'shifu.documentation-dual-reader-receipt/v1',
    verdict: 'pass',
    operation: 'context',
    inventoryRoot: HASH,
    route: {
      id: PRIMITIVE_CONTEXT_ROUTE,
      audience: 'agent',
      parityGroup: PRIMITIVE_CONTEXT_PARITY_GROUP,
    },
    projection,
  };
}

test('catalog is a deterministic projection with nine required primitives', () => {
  const catalog = buildPrimitiveCatalog(ROOT);
  assert.match(catalog.catalogRoot, /^sha256:[0-9a-f]{64}$/);
  assert.equal(catalog.schema, 'kungfu.primitive-catalog/v2');
  assert.deepEqual(
    catalog.primitives.map((entry) => entry.definition.identity.name).sort(),
    [
      'Action Geometry',
      'Assignment',
      'Cut',
      'Domain Profile',
      'Episode',
      'Fact',
      'Initiative',
      'Receipt',
      'Work',
    ],
  );
  assert.equal(catalog.relationGraph.catalogAuthoredEdges, false);
  const contractRegistry = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'framework/spec/contract/kungfu-contracts.registry.json'),
      'utf8',
    ),
  );
  assert.equal(
    contractRegistry.contracts.find(
      (entry) => entry.surface === 'primitive-catalog',
    ).schema,
    catalog.schema,
  );
  assert.ok(
    catalog.relationGraph.relations.every(
      (relation) =>
        /^sha256:[0-9a-f]{64}$/.test(relation.authority.root) &&
        relation.layerBoundary,
    ),
  );
  assert.equal(
    expectedOutputs(ROOT).get(CATALOG_SOURCE),
    expectedOutputs(ROOT).get(CATALOG_ARTIFACT),
  );
});

test('generated C++ catalog uses bounded UTF-8 literals without changing JSON', () => {
  const catalog = buildPrimitiveCatalog(ROOT);
  const payload = JSON.stringify(catalog);
  const chunks = splitUtf8ForCppLiterals(payload);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), payload);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk) <= 8 * 1024));

  const unicode = `${'a'.repeat(8)}\u529f\u592b`;
  assert.equal(splitUtf8ForCppLiterals(unicode, 9).join(''), unicode);
  assert.ok(
    splitUtf8ForCppLiterals(unicode, 9).every(
      (chunk) => Buffer.byteLength(chunk) <= 9,
    ),
  );

  const header = renderHeader(catalog);
  assert.match(header, /CATALOG_JSON_CHUNKS/u);
  assert.match(
    header,
    new RegExp(`CATALOG_JSON_SIZE = ${Buffer.byteLength(payload)}`),
  );
  assert.doesNotMatch(header, /CATALOG_JSON =\s*R"KUNGFU_PRIMITIVE/u);

  const generatedHeader = expectedOutputs(ROOT).get(CATALOG_HEADER);
  assert.match(
    generatedHeader,
    /\/\/ clang-format off[\s\S]*\/\/ clang-format on/u,
  );
});

test('ghost fixture is rejected by the declaration join', () => {
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'tests/fixtures/primitive-catalog/ghost-artifact.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    findGhostArtifacts(fixture.managedFiles, fixture.declaredArtifacts),
    fixture.expectedGhosts,
  );
});

test('machine-marked primitive artifact outside managed roots fails closed', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-primitive-artifact-'),
  );
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  const relativePath = 'framework/work/action/hidden-primitive.contract.json';
  fs.mkdirSync(path.dirname(path.join(root, relativePath)), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, relativePath),
    `${JSON.stringify({
      schema: 'kungfu.primitive.contract/v1',
      primitiveId: 'hidden-primitive',
    })}\n`,
  );
  const discoveredArtifacts = discoverPrimitiveArtifacts(root, [relativePath]);
  assert.deepEqual(discoveredArtifacts, [
    {
      path: relativePath,
      primitiveId: 'hidden-primitive',
      schema: 'kungfu.primitive.contract/v1',
    },
  ]);
  assert.deepEqual(
    primitiveArtifactClosureIssues({
      managedFiles: [],
      discoveredArtifacts,
      declaredArtifacts: new Map(),
    }),
    [
      'unregistered-machine-artifact:framework/work/action/hidden-primitive.contract.json',
    ],
  );
});

test('declared primitive artifacts require a matching machine marker', () => {
  assert.deepEqual(
    primitiveArtifactClosureIssues({
      managedFiles: [
        'framework/spec/primitive/contracts/example.contract.json',
      ],
      discoveredArtifacts: [
        {
          path: 'framework/spec/primitive/contracts/example.contract.json',
          primitiveId: 'other',
          schema: 'kungfu.primitive.contract/v1',
        },
      ],
      declaredArtifacts: new Map([
        ['framework/spec/primitive/contracts/example.contract.json', 'example'],
        ['framework/spec/primitive/sdk-slots/example.json', 'example'],
      ]),
    }),
    [
      'artifact-primitive-mismatch:framework/spec/primitive/contracts/example.contract.json:other:example',
      'declared-artifact-missing-marker:framework/spec/primitive/sdk-slots/example.json',
    ],
  );
});

test('admitted primitive without four-language and dogfood proof is denied', () => {
  const states = Object.fromEntries(
    ['cpp', 'python', 'node', 'rust'].map((language) => [
      language,
      { state: language === 'cpp' ? 'proved' : 'missing' },
    ]),
  );
  const evidence = Object.fromEntries(
    ['contract', 'vectors', 'invariants', 'dogfoodReceipts'].map((kind) => [
      kind,
      { state: kind === 'contract' ? 'present' : 'missing' },
    ]),
  );
  const issues = verifyPrimitivePromotion({
    id: 'negative-fixture',
    admission: {
      summary: { state: 'admitted' },
      languageStates: states,
      evidence,
    },
  });
  assert.ok(issues.includes('negative-fixture:missing-language-proof:rust'));
  assert.ok(
    issues.includes(
      'negative-fixture:missing-promotion-evidence:dogfoodReceipts',
    ),
  );
});

test('a name and files cannot pass the strict Primitive definition threshold', () => {
  const issues = verifyPrimitiveDefinition({
    id: 'ordinary-feature',
    classification: {
      family: 'ordinary-capability',
      kind: 'command-name',
      layer: 'cli',
    },
    lifecycle: { state: 'active', successor: null },
    admissionThreshold: {
      independentDurableSemantics: false,
      crossDomainOrRuntimeRelevance: 'not-claimed',
      boundaryParticipation: 'none',
      deletionRationale: '',
      substitutionRationale: '',
      compressionRationale: '',
    },
  });
  assert.ok(
    issues.includes('ordinary-feature:no-independent-durable-semantics'),
  );
  assert.ok(issues.includes('ordinary-feature:invalid-boundary-participation'));
  assert.ok(issues.includes('ordinary-feature:missing-deletion-rationale'));
});

test('admission is a seven-axis evidence vector and labels cannot create proof', () => {
  const fact = buildPrimitiveCatalog(ROOT).primitives.find(
    (entry) => entry.id === 'fact',
  );
  assert.deepEqual(Object.keys(fact.admission.vector).sort(), [
    'artifactShipment',
    'implementationCompleteness',
    'languageConformance',
    'operationalEvidence',
    'qualification',
    'retainedUseEvidence',
    'semanticStability',
  ]);
  assert.equal(fact.admission.summary.conclusionOnly, true);
  assert.equal(fact.admission.summary.mutableByLabel, false);
  assert.equal(fact.admission.vector.retainedUseEvidence.state, 'unproved');
});

test('typed relations preserve layer distinctions and never originate in the catalog', () => {
  const catalog = buildPrimitiveCatalog(ROOT);
  const assignment = catalog.relationGraph.relations.filter(
    (relation) => relation.source === 'assignment',
  );
  assert.deepEqual(
    assignment.map((relation) => [relation.kind, relation.target]),
    [
      ['binds', 'action-geometry'],
      ['depends-on', 'initiative'],
    ],
  );
  assert.equal(
    catalog.relationGraph.authority,
    'referenced semantic authorities',
  );
});

test('birth scaffold starts at the passport and makes no maturity claim', () => {
  const scaffold = primitiveScaffold({
    id: 'example-primitive',
    name: 'Example Primitive',
    layer: 'example',
    family: 'ordinary-capability',
    kind: 'example-responsibility',
    boundaryParticipation: 'responsibility',
    deletionRationale: 'Deletion removes the example responsibility.',
    substitutionRationale: 'No existing Primitive substitutes for the example.',
    compressionRationale: 'Compression would fuse separate responsibilities.',
    today: '2026-07-24',
  });
  const declaration = scaffold.passport.primitiveDeclarations[0];
  assert.equal(scaffold.passport.id, 'kungfu.primitive.example-primitive');
  assert.equal(declaration.classification.family, 'ordinary-capability');
  assert.deepEqual(declaration.promotionEvidence.dogfoodReceipts, []);
  assert.equal(
    JSON.parse(
      scaffold.files.get(
        'framework/spec/primitive/contracts/example-primitive.contract.json',
      ),
    ).primitiveId,
    'example-primitive',
  );
  assert.deepEqual([...scaffold.files.keys()].sort(), [
    'framework/spec/primitive/contracts/example-primitive.contract.json',
    'framework/spec/primitive/operation-slots/example-primitive.json',
    'framework/spec/primitive/sdk-slots/example-primitive.json',
    'tests/fixtures/primitive/example-primitive/vectors.json',
  ]);
});

test('Primitive authoring binds the exact complete management Task Chart', () => {
  const binding = primitiveContextBinding(
    contextReceipt('context-bound'),
    'context-bound',
  );
  assert.equal(binding.route, PRIMITIVE_CONTEXT_ROUTE);
  assert.equal(binding.parityGroup, PRIMITIVE_CONTEXT_PARITY_GROUP);
  assert.equal(binding.projectionRoot, HASH);
  assert.deepEqual(binding.omissions, []);
  assert.deepEqual(binding.unitRoots, [
    {
      id: 'primitive-authority',
      path: 'CONTRIBUTING.md',
      contentRoot: HASH,
    },
  ]);
});

test('Primitive context rejects incomplete, omitted, and mismatched evidence', () => {
  assert.throws(
    () =>
      primitiveContextBinding(
        contextReceipt('context-negative', { status: 'degraded' }),
        'context-negative',
      ),
    /incomplete/,
  );
  assert.throws(
    () =>
      primitiveContextBinding(
        contextReceipt('context-negative', {
          omissions: [{ node: 'required-authority', required: true }],
        }),
        'context-negative',
      ),
    /contains omissions/,
  );
  assert.throws(
    () =>
      primitiveContextBinding(
        contextReceipt('context-negative'),
        'different-primitive',
      ),
    /route or task binding mismatched/,
  );
});

test('agent-managed Primitive writes require an exact current context Root', async () => {
  const binding = primitiveContextBinding(
    contextReceipt('agent-write-guard'),
    'agent-write-guard',
  );
  const baseArgs = [
    '--id',
    'agent-write-guard',
    '--name',
    'Agent Write Guard',
    '--layer',
    'test',
    ...STRICT_DEFINITION_ARGS,
    '--actor',
    'agent',
    '--write',
  ];
  await assert.rejects(
    runPrimitiveAuthoring({
      args: baseArgs,
      root: ROOT,
      contextCompiler: async () => binding,
    }),
    /requires --context-root/,
  );
  await assert.rejects(
    runPrimitiveAuthoring({
      args: [...baseArgs, '--context-root', `sha256:${'2'.repeat(64)}`],
      root: ROOT,
      contextCompiler: async () => binding,
    }),
    /stale or mismatched/,
  );
});

test('Primitive writes require an explicit auditable actor', async () => {
  await assert.rejects(
    runPrimitiveAuthoring({
      args: [
        '--id',
        'missing-actor',
        '--name',
        'Missing Actor',
        '--layer',
        'test',
        ...STRICT_DEFINITION_ARGS,
        '--write',
      ],
      root: ROOT,
      contextCompiler: async () => {
        throw new Error('context compiler should not run');
      },
    }),
    /requires explicit --actor/,
  );
});

test('Primitive write receipt binds actor, context, catalog transition, and paths', async () => {
  const id = 'write-receipt';
  const binding = primitiveContextBinding(contextReceipt(id), id);
  const writes = [];
  let catalogRead = 0;
  const receipt = await runPrimitiveAuthoring({
    args: [
      '--id',
      id,
      '--name',
      'Write Receipt',
      '--layer',
      'test',
      ...STRICT_DEFINITION_ARGS,
      '--actor',
      'agent',
      '--context-root',
      HASH,
      '--write',
    ],
    root: ROOT,
    contextCompiler: async () => binding,
    catalogBuilder: () => ({
      catalogRoot: `sha256:${String(++catalogRead).repeat(64)}`,
    }),
    scaffoldApplier: ({ write }) => {
      writes.push(write);
      return ['framework/spec/incubation/incubation-passport.registry.json'];
    },
  });
  assert.deepEqual(writes, [false, true]);
  assert.equal(receipt.actor, 'agent');
  assert.equal(receipt.context.projectionRoot, HASH);
  assert.equal(receipt.catalog.beforeRoot, `sha256:${'1'.repeat(64)}`);
  assert.equal(receipt.catalog.afterRoot, `sha256:${'2'.repeat(64)}`);
  assert.deepEqual(receipt.paths, [
    'framework/spec/incubation/incubation-passport.registry.json',
  ]);
});
