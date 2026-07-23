// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyAdrMigrationPlan,
  completeAdrMigrationPlan,
  createAdrMigrationPlan,
  regenerationCheckArgs,
} from './adr-migration.mjs';

const roots = [];
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function git(root, args, extraEnv = {}) {
  return childProcess
    .execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith('GIT_'),
          ),
        ),
        ...extraEnv,
      },
    })
    .trim();
}

function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function byteRoot(value) {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function record(id, title) {
  return `---
metadata_schema: kungfu.document-metadata/v1
doc_type: architecture-decision
adr_id: ${id}
decision_status: accepted
implementation_status: unknown
review_state: legacy-unreviewed
sensitivity: public
---

# ${id}: ${title}

- Status: accepted
`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-adr-migration-'));
  roots.push(root);
  write(
    root,
    'biome.json',
    fs.readFileSync(path.join(REPO_ROOT, 'biome.json')),
  );
  write(
    root,
    'package.json',
    `${JSON.stringify({ devDependencies: { '@biomejs/biome': '1.9.4' } }, null, 2)}\n`,
  );
  const records = [
    { id: 'ADR-0001', path: 'docs/adr/ADR-0001-first.md' },
    { id: 'SHIFU-ADR-0002', path: 'docs/adr/SHIFU-ADR-0002-second.md' },
  ];
  write(
    root,
    'docs/adr/legacy-identities.v1.json',
    `${JSON.stringify({
      schema: 'kungfu.adr-legacy-identities/v1',
      cutoverCommit: 'a'.repeat(40),
      records,
    })}\n`,
  );
  write(root, records[0].path, record(records[0].id, 'First'));
  write(root, records[1].path, record(records[1].id, 'Second'));
  write(
    root,
    '.xinfa/project.json',
    `${JSON.stringify(
      {
        bindings: [
          {
            targetPath: records[0].path,
            expectedRevision: byteRoot(record(records[0].id, 'First')),
          },
          {
            targetPath: records[1].path,
            expectedRevision: byteRoot(record(records[1].id, 'Second')),
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const legacyAtlasRoots =
    '{"description":"Legacy roots described by ADR-0001"}\n';
  write(root, '.xinfa/manifests/legacy-atlas-roots.json', legacyAtlasRoots);
  write(
    root,
    'scripts/pinned-legacy-atlas-roots.mjs',
    `export const ROOT = '${byteRoot(legacyAtlasRoots)}';\n`,
  );
  write(
    root,
    'docs/README.md',
    '[First](adr/ADR-0001-first.md), SHIFU-ADR-0002, and unrelated ADR-00010.\n',
  );
  write(
    root,
    'docs/adr/README.md',
    '| ADR | Status | Title |\n|---|---|---|\n| [0001](ADR-0001-first.md) | accepted | historical ADR-0001 |\n',
  );
  write(
    root,
    'docs.contract.json',
    `${JSON.stringify(
      {
        publication: {
          implicitCollections: [
            {
              index: 'docs/adr/README.md',
              patterns: [
                '^docs/adr/(?:KF|SHIFU)-ADR-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[^/]+\\.md$',
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  write(
    root,
    'crates/xinfa/fixtures/golden/context-quality-corpus-v1.json',
    '{"critical_sources":["docs/adr/ADR-0001-first.md"]}\n',
  );
  write(
    root,
    'crates/xinfa/fixtures/golden/history.json',
    '{"decision":"ADR-0001"}\n',
  );
  write(
    root,
    'scripts/legacy-negative.test.mjs',
    "assert.equal(classify('ADR-0001').kind, 'legacy');\n",
  );
  write(
    root,
    'scripts/adr-identity.test.mjs',
    "assert.equal(classifyPath('docs/adr/ADR-0001-first.md'), 'legacy');\n",
  );
  write(
    root,
    'scripts/current-contract.test.mjs',
    "readFileSync('docs/adr/ADR-0001-first.md');\n",
  );
  write(
    root,
    'scripts/format-sensitive.mjs',
    "console.error('ADR-0001 boundary violation must remain source-formatted after identity migration');\n",
  );
  write(root, '.gitignore', '# ADR-0001\n');
  write(root, 'shifu', '# ADR-0001; docs/adr/ADR-0001-first.md\n');
  write(root, 'shifu.cmd', 'rem ADR-0001; docs/adr/ADR-0001-first.md\n');
  write(root, 'framework/core/.cmake/compiler.cmake', '# ADR-0001\n');
  write(root, 'framework/core/schema/example.fbs', '// ADR-0001\n');
  write(root, 'product/runtime-pins.env', '# ADR-0001\n');
  write(
    root,
    '.kungfu/episodes/sealed/sha256/example/claims.jsonl',
    '{"decision":"ADR-0001"}\n',
  );
  write(
    root,
    'docs/qualification/evidence/durability/example.raw/evidence.log',
    'ADR-0001\n',
  );
  write(
    root,
    '.buildchain/kfd/kfd-2/claims/example.json',
    '{"evidence":"docs/adr/ADR-0001-first.md"}\n',
  );
  write(
    root,
    'framework/core/src/python/kungfu/agent/cli_surface.catalog.json.bak',
    '{"evidence":"docs/adr/ADR-0001-first.md"}\n',
  );
  write(
    root,
    'developer/sdk/kfd/kfd-2/release-claims.json',
    '{"evidence":"docs/adr/ADR-0001-first.md"}\n',
  );
  write(
    root,
    '.buildchain/kfd/kfd-3/surfaces.json',
    '{"decision":"ADR-0001"}\n',
  );
  write(
    root,
    'framework/contract/kungfu-agent-first-canonical-policy.json',
    '{"decision":"ADR-0001"}\n',
  );
  write(
    root,
    'config/kungfu-agent-first-canonical-policy.json',
    '{"decision":"ADR-0001"}\n',
  );
  write(
    root,
    'crates/xinfa/qualification/context-quality-v1.json',
    '{"decision":"ADR-0001"}\n',
  );
  write(
    root,
    'docs/qualification/gates/workflow-authority.json',
    '{"decision":"ADR-0001"}\n',
  );
  write(
    root,
    'framework/core/src/python/kungfu/agent/cli_surface.catalog.json',
    '{"summary":"ADR-0001"}\n',
  );
  write(
    root,
    'framework/core/src/python/kungfu/cli/surface_contract.registry.json',
    '{"summary":"ADR-0001"}\n',
  );
  write(
    root,
    'framework/core/architecture/LAYERS.md',
    'Architecture authority for ADR-0001.\n',
  );
  write(
    root,
    'framework/invariant/kungfu-invariant.registry.json',
    '{"decision":"ADR-0001"}\n',
  );
  write(
    root,
    '.xinfa/baselines/sha256/example/atlas.json',
    '{"decision":"ADR-0000","related":"ADR-0001"}\n',
  );
  write(
    root,
    '.kungfu/project-cuts/sha256/example/manifest.json',
    '{"decision":"ADR-0000","related":"SHIFU-ADR-0002"}\n',
  );
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['add', '.']);
  git(
    root,
    ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-m', 'fixture'],
    {
      GIT_AUTHOR_DATE: '2026-07-22T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-07-22T00:00:00Z',
    },
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

test('plans deterministic ID-only renames from an exact Git tree', () => {
  const root = fixture();
  const first = createAdrMigrationPlan({ root });
  const second = createAdrMigrationPlan({ root });

  assert.deepEqual(first, second);
  assert.match(first.source.root, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.mappings.length, 2);
  assert.equal(first.revisionMappings.length, 2);
  assert.equal(first.artifactRevisionMappings.length, 1);
  assert.ok(
    first.mappings.every(
      (row) =>
        row.targetPath === `docs/adr/${row.targetId}.md` &&
        !row.targetPath.includes('-first') &&
        !row.targetPath.includes('-second'),
    ),
  );
  assert.equal(first.problems.length, 0);
  assert.deepEqual(first.conservation, {
    sourceIdentities: 2,
    targetIdentities: 2,
    oneToOne: true,
  });
  assert.equal(
    first.source.scannedFiles,
    git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').length,
  );
  const transformed = new Set(first.transformations.map((row) => row.path));
  for (const rel of [
    '.gitignore',
    'shifu',
    'shifu.cmd',
    'framework/core/.cmake/compiler.cmake',
    'framework/core/schema/example.fbs',
    'product/runtime-pins.env',
    'crates/xinfa/fixtures/golden/context-quality-corpus-v1.json',
  ])
    assert.ok(transformed.has(rel), `expected authored rewrite: ${rel}`);
  assert.equal(
    first.transformations.find((row) => row.path === 'docs/adr/README.md')
      ?.rewriteMode,
    'index-retire',
  );
  assert.equal(
    first.transformations.find((row) => row.path === 'docs.contract.json')
      ?.rewriteMode,
    'publication-contract',
  );
  assert.equal(
    first.transformations.find(
      (row) => row.path === 'scripts/current-contract.test.mjs',
    )?.rewriteMode,
    'paths-only',
  );
  assert.equal(
    first.transformations.find(
      (row) => row.path === 'scripts/format-sensitive.mjs',
    )?.formatMode,
    'biome',
  );
  const preserved = new Map(
    first.preserved.map((row) => [row.path, row.lifecycle]),
  );
  assert.equal(
    preserved.get('scripts/legacy-negative.test.mjs'),
    'test-fixture',
  );
  assert.equal(
    preserved.get('scripts/adr-identity.test.mjs'),
    'semantic-fixture',
  );
  assert.equal(
    preserved.get('.kungfu/episodes/sealed/sha256/example/claims.jsonl'),
    'historical-append-only',
  );
  assert.equal(
    preserved.get(
      'docs/qualification/evidence/durability/example.raw/evidence.log',
    ),
    'historical-append-only',
  );
  assert.equal(
    preserved.get('.buildchain/kfd/kfd-2/claims/example.json'),
    'generated',
  );
  assert.equal(
    preserved.get('developer/sdk/kfd/kfd-2/release-claims.json'),
    'generated',
  );
  assert.equal(
    transformed.has(
      'framework/core/src/python/kungfu/agent/cli_surface.catalog.json.bak',
    ),
    true,
    'a sibling of a declared output file must remain authored',
  );
  for (const rel of [
    'framework/contract/kungfu-agent-first-canonical-policy.json',
    'config/kungfu-agent-first-canonical-policy.json',
    '.buildchain/kfd/kfd-3/surfaces.json',
    'crates/xinfa/qualification/context-quality-v1.json',
    'docs/qualification/gates/workflow-authority.json',
    'framework/core/src/python/kungfu/agent/cli_surface.catalog.json',
    'framework/core/src/python/kungfu/cli/surface_contract.registry.json',
    'framework/core/architecture/LAYERS.md',
    'framework/invariant/kungfu-invariant.registry.json',
  ]) {
    assert.equal(
      preserved.get(rel),
      'generated',
      `expected declared regeneration output to be generated: ${rel}`,
    );
    assert.equal(
      transformed.has(rel),
      false,
      `declared regeneration output must not be a transformation: ${rel}`,
    );
  }
  assert.deepEqual(
    first.regenerations.map((row) => row.command),
    [
      './shifu node developer/sdk/src/sdk.js contract policy --write --json',
      './shifu kfd:buildchain',
      './shifu node scripts/qualify-xinfa-context-quality.mjs --write',
      './shifu gate:workflow-authority:refresh',
      './shifu fix:cli-catalog-parity',
      './shifu invariant:verify -- --sync-roots --write --json',
      './shifu core:architecture:write',
    ],
  );
  assert.deepEqual(
    first.regenerations.map((row) => row.checkCommand),
    [
      './shifu node developer/sdk/src/sdk.js contract policy --check --json',
      './shifu kfd:buildchain:check',
      './shifu xinfa:quality',
      './shifu check:gate-catalog',
      './shifu check:cli-catalog-parity',
      './shifu invariant:verify -- --sync-roots --json',
      './shifu check:source',
    ],
  );
  assert.deepEqual(first.regenerations[0].paths, [
    'framework/contract/kungfu-agent-first-canonical-policy.json',
    'config/kungfu-agent-first-canonical-policy.json',
  ]);
  assert.deepEqual(first.regenerations[1].paths, [
    '.buildchain/kfd/kfd-3/surfaces.json',
    'developer/sdk/kfd/kfd-3-surfaces.json',
    'developer/sdk/kfd/upstream-aggregate.json',
    '.buildchain/kfd/kfd-1/contract-world.witness.json',
    '.buildchain/kfd/kfd-1/release-gate.json',
    '.buildchain/kfd/kfd-1/verify-result.json',
    '.buildchain/kfd/kfd-2/claims/',
    '.buildchain/kfd/kfd-2/release-claims.json',
    'developer/sdk/kfd/kfd-1/contract-world.witness.json',
    'developer/sdk/kfd/kfd-1/release-gate.json',
    'developer/sdk/kfd/kfd-1/verify-result.json',
    'developer/sdk/kfd/kfd-2/release-claims.json',
    'developer/sdk/kfd/kfd-2/claims/',
    '.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json',
    '.buildchain/kfd/kfd-3/collaboration-interface.artifact.json',
    '.buildchain/kfd/kfd-3/capability-query.json',
    '.buildchain/kfd/buildchain-kfd-summary.json',
  ]);
  assert.deepEqual(first.regenerations[3].paths, [
    'docs/qualification/gates/workflow-authority.json',
  ]);
  assert.deepEqual(first.regenerations[4].paths, [
    'framework/core/src/python/kungfu/cli/surface_contract.registry.json',
    'framework/core/src/python/kungfu/agent/cli_surface.catalog.json',
  ]);
  assert.deepEqual(first.regenerations[5].paths, [
    'framework/invariant/kungfu-invariant.registry.json',
  ]);
  assert.deepEqual(first.regenerations[6].paths, [
    'framework/core/architecture/LAYERS.md',
    'framework/core/architecture/TARGETS.cmake',
    'framework/core/architecture/PUBLIC_CONTRACTS.cmake',
    'framework/core/architecture/ARCHITECTURE_INDEX.md',
    'framework/core/architecture/ARCHITECTURE_HEALTH.md',
    'framework/core/architecture/review-routes.json',
  ]);
});

test('keeps regeneration declarations immutable across plans', () => {
  const root = fixture();
  const first = createAdrMigrationPlan({ root });
  first.regenerations.pop();
  first.regenerations[0].paths.pop();

  const second = createAdrMigrationPlan({ root });
  assert.equal(second.regenerations.length, 7);
  assert.equal(second.regenerations[0].paths.length, 2);
  assert.equal(
    second.regenerations.at(-1)?.checkCommand,
    './shifu check:source',
  );
  assert.equal(
    new Set(second.regenerations.flatMap((row) => row.paths)).size,
    30,
  );
  for (const regeneration of second.regenerations) {
    assert.ok(regenerationCheckArgs(regeneration.checkCommand).length > 0);
  }
  assert.throws(
    () => regenerationCheckArgs('./shifu unknown:regeneration-check'),
    /unrecognized regeneration check/,
  );
});

test('pins web formatting to the exact source snapshot configuration', () => {
  const root = fixture();
  const first = createAdrMigrationPlan({ root });
  const configPath = path.join(root, 'biome.json');
  const drifted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  drifted.formatter.lineWidth = 200;
  fs.writeFileSync(configPath, `${JSON.stringify(drifted, null, 2)}\n`);

  const repeated = createAdrMigrationPlan({ root });
  assert.deepEqual(repeated, first);
});

test('fails closed when the installed formatter differs from the source pin', () => {
  const root = fixture();
  fs.writeFileSync(
    path.join(root, 'package.json'),
    `${JSON.stringify({ devDependencies: { '@biomejs/biome': '9.9.9' } }, null, 2)}\n`,
  );
  git(root, ['add', 'package.json']);
  git(root, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '-m',
    'formatter drift',
  ]);

  assert.throws(
    () => createAdrMigrationPlan({ root }),
    /Biome version drift: expected 9\.9\.9, got 1\.9\.4/,
  );
});

test('applies a reviewed manifest idempotently and preserves historical bytes', () => {
  const root = fixture();
  const plan = createAdrMigrationPlan({ root });
  const historical = path.join(
    root,
    'crates/xinfa/fixtures/golden/history.json',
  );
  const before = fs.readFileSync(historical);

  const applied = applyAdrMigrationPlan(root, plan, plan.source.root);
  assert.equal(applied.changed, true);
  assert.equal(applied.status, 'regeneration-required');
  assert.deepEqual(applied.regenerations, plan.regenerations);
  const repeated = applyAdrMigrationPlan(root, plan, plan.source.root);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.status, 'regeneration-required');
  assert.deepEqual(fs.readFileSync(historical), before);
  for (const row of plan.mappings) {
    assert.equal(fs.existsSync(path.join(root, row.path)), false);
    assert.equal(fs.existsSync(path.join(root, row.targetPath)), true);
  }
  const docs = fs.readFileSync(path.join(root, 'docs/README.md'), 'utf8');
  assert.ok(plan.mappings.every((row) => docs.includes(row.targetId)));
  assert.match(docs, /ADR-00010/);
  const project = JSON.parse(
    fs.readFileSync(path.join(root, '.xinfa/project.json'), 'utf8'),
  );
  for (const [index, mapping] of plan.mappings.entries()) {
    assert.equal(project.bindings[index].targetPath, mapping.targetPath);
    assert.equal(
      project.bindings[index].expectedRevision,
      byteRoot(fs.readFileSync(path.join(root, mapping.targetPath))),
    );
  }
  const index = fs.readFileSync(path.join(root, 'docs/adr/README.md'), 'utf8');
  assert.match(index, /\| ADR \| Status \| Title \|/);
  assert.doesNotMatch(index, /\[0001\]/);
  assert.doesNotMatch(index, /historical ADR-0001/);
  assert.ok(!index.includes(path.posix.basename(plan.mappings[0].targetPath)));
  const docsContract = fs.readFileSync(
    path.join(root, 'docs.contract.json'),
    'utf8',
  );
  assert.equal(
    JSON.parse(docsContract).publication.implicitCollections[0].patterns[0],
    '^docs/adr/(?:KF|SHIFU)-ADR-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.md$',
  );
  const migratedLegacyAtlasRoots = fs.readFileSync(
    path.join(root, '.xinfa/manifests/legacy-atlas-roots.json'),
  );
  const pinnedLegacyAtlasRoots = fs.readFileSync(
    path.join(root, 'scripts/pinned-legacy-atlas-roots.mjs'),
    'utf8',
  );
  assert.match(
    pinnedLegacyAtlasRoots,
    new RegExp(byteRoot(migratedLegacyAtlasRoots)),
  );
  const currentTest = fs.readFileSync(
    path.join(root, 'scripts/current-contract.test.mjs'),
    'utf8',
  );
  assert.ok(currentTest.includes(plan.mappings[0].targetPath));
  const formatSensitive = fs.readFileSync(
    path.join(root, 'scripts/format-sensitive.mjs'),
    'utf8',
  );
  assert.match(formatSensitive, /console\.error\(\n/);
  const biome = path.join(
    REPO_ROOT,
    'node_modules',
    '@biomejs',
    'biome',
    'bin',
    'biome',
  );
  childProcess.execFileSync(
    process.execPath,
    [
      biome,
      'check',
      '--no-errors-on-unmatched',
      'scripts/format-sensitive.mjs',
    ],
    { cwd: root, stdio: 'pipe' },
  );
  const semanticFixture = fs.readFileSync(
    path.join(root, 'scripts/adr-identity.test.mjs'),
    'utf8',
  );
  assert.match(semanticFixture, /docs\/adr\/ADR-0001-first\.md/);
  fs.appendFileSync(historical, 'drift\n');
  assert.throws(
    () => applyAdrMigrationPlan(root, plan, plan.source.root),
    /preserved migration input drifted/,
  );
});

test('completes only after declared regeneration checks and output closure', () => {
  const root = fixture();
  const plan = createAdrMigrationPlan({ root });
  applyAdrMigrationPlan(root, plan, plan.source.root);
  for (const regeneration of plan.regenerations) {
    for (const output of regeneration.paths) {
      if (output.endsWith('/')) write(root, `${output}fixture.json`, '{}\n');
      else write(root, output, '{}\n');
    }
  }
  const checks = [];
  const receipt = completeAdrMigrationPlan(
    root,
    plan,
    plan.source.root,
    (_root, command) => checks.push(command),
  );
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.manifestRoot, plan.manifestRoot);
  assert.match(receipt.resultRoot, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    checks,
    plan.regenerations.map((row) => row.checkCommand),
  );
  assert.deepEqual(receipt.checks, checks);
  assert.equal(
    receipt.outputs.length,
    plan.regenerations.reduce((sum, row) => sum + row.paths.length, 0),
  );
  const preservedPaths = new Set(plan.preserved.map((row) => row.path));
  const missingOutput = plan.regenerations
    .flatMap((regeneration) => regeneration.paths)
    .find((output) => !output.endsWith('/') && !preservedPaths.has(output));
  assert.ok(missingOutput);
  fs.rmSync(path.join(root, missingOutput));
  assert.throws(
    () =>
      completeAdrMigrationPlan(root, plan, plan.source.root, () => undefined),
    /declared regeneration output is missing/,
  );
});

test('fails closed on expected-root or working-file drift', () => {
  const root = fixture();
  const plan = createAdrMigrationPlan({ root });
  assert.throws(
    () => applyAdrMigrationPlan(root, plan, `sha256:${'0'.repeat(64)}`),
    /expected source root/,
  );
  fs.appendFileSync(path.join(root, 'docs/README.md'), 'drift\n');
  assert.throws(
    () => applyAdrMigrationPlan(root, plan, plan.source.root),
    /differs from both manifest source and result/,
  );
});

test('fails closed unless the legacy publication pattern occurs exactly once', () => {
  const legacyPattern =
    '^docs/adr/(?:KF|SHIFU)-ADR-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-[^/]+\\.md$';
  for (const patterns of [[], [legacyPattern, legacyPattern]]) {
    const root = fixture();
    const contractPath = path.join(root, 'docs.contract.json');
    const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
    contract.publication.implicitCollections[0].patterns = patterns;
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
    git(root, ['add', 'docs.contract.json']);
    git(root, [
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '-m',
      'drift publication contract',
    ]);

    const plan = createAdrMigrationPlan({ root });
    assert.ok(
      plan.problems.some(
        (problem) =>
          problem.code === 'publication-contract-pattern-cardinality' &&
          problem.actual === patterns.length,
      ),
    );
    assert.throws(
      () => applyAdrMigrationPlan(root, plan, plan.source.root),
      /unresolved problems/,
    );
  }
});

test('fails closed when revision rewriting changes a target ADR root again', () => {
  const root = fixture();
  const first = 'docs/adr/ADR-0001-first.md';
  const second = 'docs/adr/SHIFU-ADR-0002-second.md';
  fs.appendFileSync(
    path.join(root, first),
    `\nPinned dependency: ${byteRoot(fs.readFileSync(path.join(root, second)))}\n`,
  );
  git(root, ['add', first]);
  git(root, [
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '-q',
    '-m',
    'add revision dependency',
  ]);

  const plan = createAdrMigrationPlan({ root });
  assert.ok(
    plan.problems.some(
      (problem) =>
        problem.code === 'adr-revision-closure-nonterminal' &&
        problem.id === 'ADR-0001',
    ),
  );
  assert.throws(
    () => applyAdrMigrationPlan(root, plan, plan.source.root),
    /unresolved problems/,
  );
});
