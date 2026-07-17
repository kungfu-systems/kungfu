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
  humanSurfaceXinfaProject,
} from './shifu-documentation-surfaces.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFU_MJS = path.join(ROOT, 'shifu.mjs');

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
