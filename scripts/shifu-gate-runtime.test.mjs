// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkShifuGateContract } from './check-shifu-gate-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFU_MJS = path.join(ROOT, 'shifu.mjs');
const REGISTRY = path.join(
  ROOT,
  'docs',
  'shifu',
  'examples',
  'gates',
  'minimal.gate-registry.json',
);

function gate(args) {
  return spawnSync(process.execPath, [SHIFU_MJS, 'gate', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

test('gate contract accepts the valid fixture and rejects every semantic failure class', async () => {
  const result = await checkShifuGateContract(ROOT);
  assert.equal(result.validFixtures, 1);
  assert.equal(result.rejectedFixtures, 5);
});

for (const [label, args, source] of [
  ['contract', ['contract'], 'docs/shifu/gate-contract.json'],
  [
    'registry schema',
    ['schema', 'registry'],
    'docs/shifu/schema/gate-registry-v1.schema.json',
  ],
  [
    'plan schema',
    ['schema', 'plan'],
    'docs/shifu/schema/gate-plan-v1.schema.json',
  ],
  [
    'receipt schema',
    ['schema', 'receipt'],
    'docs/shifu/schema/gate-receipt-v1.schema.json',
  ],
]) {
  test(`shifu exposes the exact checked-in Gate ${label}`, () => {
    const result = gate(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      fs.readFileSync(path.join(ROOT, source), 'utf8'),
    );
  });
}

test('validate remains available when the selected registry is invalid', () => {
  const invalid = path.join(
    ROOT,
    'docs',
    'shifu',
    'examples',
    'gates',
    'invalid',
    'cycle.gate-registry.json',
  );
  const result = gate(['validate', '--registry', invalid, '--json']);
  assert.equal(result.status, 1, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.schema, 'shifu.gate-validation/v1');
  assert.equal(value.valid, false);
  assert.ok(value.issues.some((issue) => issue.code === 'dependency-cycle'));
});

test('list, show, explain and matrix have versioned deterministic JSON', () => {
  for (const [command, expectedSchema] of [
    [['list'], 'shifu.gate-list/v1'],
    [['show', 'source.contract'], 'shifu.gate-detail/v1'],
    [
      ['explain', 'source.contract', '--profile', 'development'],
      'shifu.gate-detail/v1',
    ],
    [['matrix'], 'shifu.gate-matrix/v1'],
  ]) {
    const result = gate([...command, '--registry', REGISTRY, '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).schema, expectedSchema);
  }
});

test('plan closes dependencies into deterministic parallel groups', () => {
  const result = gate([
    'plan',
    'release',
    '--registry',
    REGISTRY,
    '--platform',
    'linux',
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.deepEqual(
    plan.groups.map((group) => group.gates.map((item) => item.id)),
    [['source.format'], ['source.contract'], ['native.smoke']],
  );
  assert.equal(plan.qualifying, true);
});

test('explicit diagnostic selection is non-qualifying and still closes dependencies', () => {
  const result = gate([
    'plan',
    'development',
    '--gate',
    'native.smoke',
    '--registry',
    REGISTRY,
    '--platform',
    'linux',
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.qualifying, false);
  assert.deepEqual(plan.explicitGates, ['native.smoke']);
  assert.deepEqual(
    plan.groups.map((group) => group.gates.map((item) => item.id)),
    [['source.format'], ['source.contract'], ['native.smoke']],
  );
});

test('required unsupported gates fail the plan without pretending to skip', () => {
  const result = gate([
    'plan',
    'release',
    '--registry',
    REGISTRY,
    '--platform',
    'windows',
    '--json',
  ]);
  assert.equal(result.status, 1, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.groups, []);
  assert.deepEqual(
    plan.unsupported.map((item) => item.id),
    ['native.smoke'],
  );
});

test('explicit gate execution emits a non-qualifying unified receipt', () => {
  const executionRegistry = path.join(
    ROOT,
    'docs',
    'shifu',
    'examples',
    'gates',
    'execution.gate-registry.json',
  );
  const result = gate([
    'run',
    'fixture.left',
    'fixture.right',
    '--registry',
    executionRegistry,
    '--json',
  ]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.schema, 'shifu.gate-receipt/v1');
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.qualifying, false);
  assert.equal(
    receipt.registry.ref,
    'docs/shifu/examples/gates/execution.gate-registry.json',
  );
  assert.deepEqual(
    receipt.results.map((item) => item.gateId),
    ['fixture.prepare', 'fixture.left', 'fixture.right'],
  );
});

test('the legacy rich-command error still rejects unrelated unknown commands', () => {
  const result = spawnSync(
    process.execPath,
    [SHIFU_MJS, 'not-a-rich-command'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown command/);
});
