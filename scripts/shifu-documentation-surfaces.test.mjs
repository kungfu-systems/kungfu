// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildHumanSurfaceInventory,
  documentationAuthoringImpact,
  humanSurfaceXinfaProject,
} from './shifu-documentation-surfaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFU_MJS = path.join(ROOT, 'shifu.mjs');
const FIXTURE_COMPATIBILITY = [
  {
    id: 'fixture-check',
    legacyEntrypoint: './check',
    status: 'composed',
    owner: 'fixture-docs',
    preservedCapabilities: ['structure'],
    canonicalEntrypoints: ['./shifu docs inventory --json'],
    sunsetCondition: 'Retain until the fixture has an equivalent native gate.',
  },
];
const FIXTURE_RESOLUTION = {
  subjects: ['documentation'],
  capabilities: ['repository-navigation'],
  owners: ['fixture-docs'],
  roles: ['implementer'],
  mission_tracks: ['fixture'],
  terms: ['documentation'],
};

test('human surface inventory and Xinfa submission are deterministic', () => {
  const first = buildHumanSurfaceInventory({ root: ROOT });
  const second = buildHumanSurfaceInventory({ root: ROOT });
  assert.equal(second.inventoryRoot, first.inventoryRoot);
  assert.deepEqual(second.entries, first.entries);
  assert.equal(first.closure.unclassified, 0);
  assert.equal(
    first.closure.humanSurfacePaths,
    new Set(first.entries.map((entry) => entry.path)).size,
  );

  const project = humanSurfaceXinfaProject(first);
  assert.equal(
    project.providers[0].paths.length,
    first.closure.exactProviderPaths,
  );
  assert.equal(
    project.nodes.length,
    first.entries.length +
      new Set(first.bindings.map((binding) => binding.targetId)).size,
  );
  assert.deepEqual(project.routes[0].nodes, project.routes[1].nodes);
  assert.deepEqual(
    first.parityGroups.map((group) => group.id),
    [
      'kungfu-core-development',
      'kungfu-documentation',
      'kungfu-documentation-control',
      'kungfu-kfx-development',
      'kungfu-user-guide',
    ],
  );
  assert.ok(
    first.parityGroups.every(
      (group) =>
        group.nodeSet === 'shared' &&
        group.audiences.join(',') === 'agent,human' &&
        group.capabilities.join(',') ===
          'value,use,authority,constraints,known-limits,evidence,next-action',
    ),
  );
  assert.match(project.providers[0].revision, /^sha256:[0-9a-f]{64}$/);
});

test('Xinfa Agent discovery closes repository, installed-pack, and dual-first routes', () => {
  const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
  const json = (relative) => JSON.parse(read(relative));
  const guide = 'docs/guides/xinfa-agent-context.md';

  for (const relative of [
    'AGENTS.md',
    'README.md',
    'docs/README.md',
    'docs/MAP.md',
    'docs/guides/README.md',
    'xinfa/README.md',
  ]) {
    assert.match(read(relative), /xinfa-agent-context\.md/);
  }

  const guideText = read(guide);
  for (const phrase of [
    './shifu docs inventory --json',
    './shifu docs context',
    'xinfa contract --json',
    'xinfa schema task-envelope',
    'kungfu agent docs --verify --json',
    'do not execute Xinfa',
  ]) {
    assert.ok(guideText.includes(phrase), `${guide} missing ${phrase}`);
  }
  assert.match(
    read('scripts/shifu-documentation-cli.mjs'),
    /budget: 66560/,
    'final-ready default must cover the documented complete Agent route',
  );
  assert.match(guideText, /66,560/);
  assert.match(read('docs/shifu/README.md'), /66,560/);

  const pack = json('framework/core/src/python/kungfu/agent/index.json');
  assert.equal(pack.contextCompiler.product, 'xinfa');
  assert.equal(pack.contextCompiler.automaticAdmission, 'coordinator-required');
  assert.ok(
    pack.documents.some((row) => row.path === 'xinfa-context.md'),
    'installed Agent pack must list xinfa-context.md',
  );

  const policy = json('shifu.documentation.surfaces.json');
  const human = policy.routes.find(
    (route) => route.id === 'kungfu-documentation-control-human',
  );
  const agent = policy.routes.find(
    (route) => route.id === 'kungfu-documentation-control-agent',
  );
  assert.deepEqual(agent.selection.paths, human.selection.paths);
  assert.ok(agent.entrypoints.includes('AGENTS.md'));
  for (const relative of [
    guide,
    'framework/core/src/python/kungfu/agent/xinfa-context.md',
  ]) {
    assert.ok(agent.selection.paths.includes(relative));
  }

  const protocol = json('shifu.documentation.json');
  for (const audience of ['agent', 'human']) {
    const route = protocol.routes.find((row) => row.audience === audience);
    assert.ok(route.entrypoints.includes(guide));
  }
});

test('a one-sided dual-first parity group fails closed', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-parity-negative-'),
  );
  try {
    fs.writeFileSync(path.join(temporary, 'known.md'), '# Known\n');
    fs.writeFileSync(
      path.join(temporary, 'policy.json'),
      JSON.stringify({
        $schema:
          'https://libkungfu.dev/schemas/shifu/documentation-surface-policy-v1.schema.json',
        schema: 'shifu.documentation-surface-policy/v1',
        project: 'fixture',
        discovery: { trackedOnly: true, extensions: ['.md'] },
        classifications: [
          {
            id: 'known',
            lifecycle: 'authored',
            documentProfile: 'authored-document',
            verificationProfile: 'human-review',
            visibility: 'public',
            owner: 'fixture-docs',
            waiver: null,
            selectors: { paths: ['known.md'] },
          },
        ],
        explicitSurfaces: [],
        bindings: [],
        compatibilityGates: FIXTURE_COMPATIBILITY,
        routes: [
          {
            id: 'human',
            audience: 'human',
            parityGroup: 'fixture',
            entrypoints: ['known.md'],
            capabilities: [
              'value',
              'use',
              'authority',
              'constraints',
              'known-limits',
              'evidence',
              'next-action',
            ],
            resolution: FIXTURE_RESOLUTION,
            selection: { mode: 'all' },
          },
        ],
      }),
    );
    assert.throws(
      () =>
        buildHumanSurfaceInventory({
          root: temporary,
          policyRef: 'policy.json',
          files: ['known.md'],
        }),
      /parity group fixture requires human and agent routes/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('documentation context stays a thin Xinfa delegation with the declared parity group', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-context-adapter-'),
  );
  const binary = path.join(temporary, 'xinfa-fixture.cjs');
  try {
    fs.writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === 'atlas' && args[1] === 'compile') {
  fs.mkdirSync(value('--output'), { recursive: true });
  process.stdout.write(JSON.stringify({ verdict: 'pass', atlas_root: 'sha256:${'1'.repeat(64)}', context_pack_root: 'sha256:${'2'.repeat(64)}' }));
} else if (args[0] === 'atlas' && args[1] === 'verify') {
  process.stdout.write(JSON.stringify({ valid: true, atlas_root: 'sha256:${'1'.repeat(64)}' }));
} else if (args[0] === 'atlas' && args[1] === 'impact') {
  process.stdout.write(JSON.stringify({ verdict: 'pass', affected: { documents: ['docs/shifu/README.md'] } }));
} else if (args[0] === 'context') {
  process.stdout.write(JSON.stringify({ schema: 'xinfa.task-chart/v1', status: 'current', route: value('--route'), parity: { atlas_root: 'sha256:${'1'.repeat(64)}' } }));
} else { process.exit(2); }
`,
    );
    fs.chmodSync(binary, 0o755);
    const ambiguous = spawnSync(
      process.execPath,
      [
        SHIFU_MJS,
        'docs',
        'context',
        '--task',
        'change documentation adapter',
        '--budget',
        '2048',
        '--xinfa',
        binary,
        '--json',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /multiple exact agent documentation routes/);
    const result = spawnSync(
      process.execPath,
      [
        SHIFU_MJS,
        'docs',
        'context',
        '--task',
        'change documentation adapter',
        '--budget',
        '2048',
        '--route',
        'kungfu-documentation-control-agent',
        '--since',
        temporary,
        '--xinfa',
        binary,
        '--json',
      ],
      { cwd: ROOT, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.schema, 'shifu.documentation-dual-reader-receipt/v1');
    assert.equal(receipt.delegated, true);
    assert.equal(receipt.route.audience, 'agent');
    assert.equal(receipt.route.parityGroup, 'kungfu-documentation-control');
    assert.equal(receipt.atlasRoot, receipt.projection.parity.atlas_root);
    assert.equal(receipt.impact.verdict, 'pass');
    assert.deepEqual(receipt.impact.impact.affected.documents, [
      'docs/shifu/README.md',
    ]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('documentation final-ready binds KFD-1 impact and dual-first projections', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-final-ready-adapter-'),
  );
  const binary = path.join(temporary, 'xinfa-fixture.cjs');
  try {
    fs.writeFileSync(
      binary,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const root = (digit) => 'sha256:' + digit.repeat(64);
if (args[0] === 'atlas' && args[1] === 'compile') {
  fs.mkdirSync(value('--output'), { recursive: true });
  process.stdout.write(JSON.stringify({ verdict: 'pass', atlas_root: root('1'), context_pack_root: root('2') }));
} else if (args[0] === 'atlas' && args[1] === 'verify') {
  process.stdout.write(JSON.stringify({ valid: true, atlas_root: root('1') }));
} else if (args[0] === 'read' || args[0] === 'context') {
  const agent = args[0] === 'context';
  const authority = agent && process.env.SHIFU_FIXTURE_DRIFT ? root('9') : root('3');
  process.stdout.write(JSON.stringify({
    schema: agent ? 'xinfa.task-chart/v1' : 'xinfa.human-view/v1',
    status: 'complete',
    omissions: [],
    parity: {
      atlas_root: root('1'), project_id: 'fixture',
      cut: { id: 'fixture', revision: root('4') }, cut_root: root('5'),
      visibility: 'public',
      route: { id: value('--route'), parity_group: 'kungfu-documentation-control', route_root: root('6'), authority_root: authority, status: 'current' },
      evidence: [], atlas_omissions: [],
      source_roots: { source: root('7'), semantic: root('8'), verification: root('0') }
    }
  }));
} else { process.exit(2); }
`,
    );
    fs.chmodSync(binary, 0o755);
    const argv = [
      SHIFU_MJS,
      'docs',
      'final-ready',
      '--since',
      'HEAD',
      '--xinfa',
      binary,
      '--json',
    ];
    const current = spawnSync(process.execPath, argv, {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(current.status, 0, current.stderr);
    const receipt = JSON.parse(current.stdout);
    assert.equal(receipt.schema, 'shifu.documentation-final-ready-receipt/v1');
    assert.equal(receipt.parity.matched, true);
    assert.equal(receipt.projections.human.projection.status, 'complete');
    assert.equal(receipt.projections.agent.projection.status, 'complete');
    assert.match(receipt.receiptRoot, /^sha256:[0-9a-f]{64}$/);

    const drifted = spawnSync(process.execPath, argv, {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, SHIFU_FIXTURE_DRIFT: '1' },
    });
    assert.equal(drifted.status, 1, drifted.stderr);
    assert.equal(JSON.parse(drifted.stdout).verdict, 'fail');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('implementation revision drift is preserved as a Xinfa document dependency mismatch', () => {
  const inventory = buildHumanSurfaceInventory({ root: ROOT });
  const binding = inventory.bindings[0];
  const drifted = {
    ...inventory,
    bindings: inventory.bindings.map((candidate) =>
      candidate.id === binding.id
        ? { ...candidate, observedRevision: `sha256:${'0'.repeat(64)}` }
        : candidate,
    ),
  };
  const project = humanSurfaceXinfaProject(drifted);
  const document = inventory.entries.find(
    (entry) =>
      entry.path === binding.documentPath && entry.kind === 'document-file',
  );
  const target = project.nodes.find((node) => node.id === binding.targetId);
  const dependency = project.nodes
    .find((node) => node.id === document.node)
    .verification.dependencies.find((item) => item.node === binding.targetId);

  assert.equal(target.revision, `sha256:${'0'.repeat(64)}`);
  assert.equal(dependency.expectedRevision, binding.expectedRevision);
  assert.notEqual(dependency.expectedRevision, target.revision);
  const affectedRoutes = project.routes.filter((route) =>
    route.nodes.includes(document.node),
  );
  assert.ok(affectedRoutes.length >= 2);
  assert.ok(
    affectedRoutes.every((route) => route.nodes.includes(binding.targetId)),
  );
});

test('authoring impact classifies review obligations and blocks historical deletion', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-authoring-impact-'),
  );
  try {
    const runGit = (...args) => {
      const result = spawnSync('git', args, {
        cwd: temporary,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
    };
    runGit('init', '-q');
    fs.writeFileSync(path.join(temporary, 'known.md'), '# Known\n');
    fs.writeFileSync(path.join(temporary, 'history.md'), '# History\n');
    fs.writeFileSync(
      path.join(temporary, 'policy.json'),
      JSON.stringify({
        $schema:
          'https://libkungfu.dev/schemas/shifu/documentation-surface-policy-v1.schema.json',
        schema: 'shifu.documentation-surface-policy/v1',
        project: 'fixture',
        discovery: { trackedOnly: true, extensions: ['.md'] },
        classifications: [
          {
            id: 'history',
            lifecycle: 'historical-append-only',
            documentProfile: 'decision-record',
            verificationProfile: 'human-review',
            visibility: 'public',
            owner: 'fixture-docs',
            waiver: null,
            selectors: { paths: ['history.md'] },
          },
          {
            id: 'expression',
            lifecycle: 'non-claim',
            documentProfile: 'authored-document',
            verificationProfile: 'non-claim',
            visibility: 'public',
            owner: 'fixture-docs',
            waiver: null,
            selectors: { paths: ['expression.md'] },
          },
          {
            id: 'authored',
            lifecycle: 'authored',
            documentProfile: 'authored-document',
            verificationProfile: 'human-review',
            visibility: 'public',
            owner: 'fixture-docs',
            waiver: null,
            selectors: { suffixes: ['.md'] },
          },
        ],
        explicitSurfaces: [],
        bindings: [],
        compatibilityGates: FIXTURE_COMPATIBILITY,
        routes: [
          {
            id: 'human',
            audience: 'human',
            parityGroup: 'fixture',
            entrypoints: ['known.md'],
            capabilities: [
              'value',
              'use',
              'authority',
              'constraints',
              'known-limits',
              'evidence',
              'next-action',
            ],
            resolution: FIXTURE_RESOLUTION,
            selection: { mode: 'all' },
          },
          {
            id: 'agent',
            audience: 'agent',
            parityGroup: 'fixture',
            entrypoints: ['known.md'],
            capabilities: [
              'value',
              'use',
              'authority',
              'constraints',
              'known-limits',
              'evidence',
              'next-action',
            ],
            resolution: FIXTURE_RESOLUTION,
            selection: { mode: 'all' },
          },
        ],
      }),
    );
    runGit('add', '.');
    runGit(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      'commit',
      '-qm',
      'fixture',
    );
    const inventory = buildHumanSurfaceInventory({
      root: temporary,
      policyRef: 'policy.json',
    });
    fs.appendFileSync(path.join(temporary, 'known.md'), 'Changed.\n');
    fs.rmSync(path.join(temporary, 'history.md'));
    fs.writeFileSync(path.join(temporary, 'expression.md'), 'A thought.\n');
    const receipt = documentationAuthoringImpact({
      root: temporary,
      since: 'HEAD',
      policyRef: 'policy.json',
      inventory,
    });
    assert.equal(receipt.verdict, 'fail');
    assert.equal(receipt.summary.affectedSurfaces, 3);
    assert.ok(
      receipt.violations.some(
        (item) =>
          item.code === 'historical-surface-deleted' &&
          item.path === 'history.md',
      ),
    );
    assert.equal(
      receipt.obligations.find((item) => item.path === 'expression.md')
        .claimImpact,
      'none',
    );
    assert.match(receipt.impactRoot, /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('an eligible surface without a classification fails closed', () => {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'shifu-surface-negative-'),
  );
  try {
    fs.writeFileSync(path.join(temporary, 'orphan.md'), '# Orphan\n');
    fs.writeFileSync(
      path.join(temporary, 'policy.json'),
      JSON.stringify({
        $schema:
          'https://libkungfu.dev/schemas/shifu/documentation-surface-policy-v1.schema.json',
        schema: 'shifu.documentation-surface-policy/v1',
        project: 'fixture',
        discovery: { trackedOnly: true, extensions: ['.md'] },
        classifications: [
          {
            id: 'known',
            lifecycle: 'authored',
            documentProfile: 'authored-document',
            verificationProfile: 'human-review',
            visibility: 'public',
            owner: 'fixture-docs',
            waiver: null,
            selectors: { paths: ['known.md'] },
          },
        ],
        explicitSurfaces: [],
        bindings: [],
        compatibilityGates: FIXTURE_COMPATIBILITY,
        routes: [
          {
            id: 'human',
            audience: 'human',
            parityGroup: 'fixture',
            entrypoints: ['orphan.md'],
            capabilities: [
              'value',
              'use',
              'authority',
              'constraints',
              'known-limits',
              'evidence',
              'next-action',
            ],
            resolution: FIXTURE_RESOLUTION,
            selection: { mode: 'all' },
          },
          {
            id: 'agent',
            audience: 'agent',
            parityGroup: 'fixture',
            entrypoints: ['orphan.md'],
            capabilities: [
              'value',
              'use',
              'authority',
              'constraints',
              'known-limits',
              'evidence',
              'next-action',
            ],
            resolution: FIXTURE_RESOLUTION,
            selection: { mode: 'all' },
          },
        ],
      }),
    );
    assert.throws(
      () =>
        buildHumanSurfaceInventory({
          root: temporary,
          policyRef: 'policy.json',
          files: ['orphan.md'],
        }),
      /unclassified human surfaces: orphan\.md/,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
