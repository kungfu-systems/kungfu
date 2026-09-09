// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';

const ROOT = process.cwd();
const CONTRACT = path.join(
  ROOT,
  'framework/core/fact/kungfu-fact-cut-kernel.contract.json',
);
const FIXTURE = path.join(
  ROOT,
  'tests/fixtures/temporal-relation-contract/cases.json',
);

test('the temporal relation contract remains neutral and rooted in KFR2', () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8'));
  const temporal = contract.temporalRelations;
  assert.equal(temporal.status, 'implemented');
  assert.equal(temporal.rootProtocol, 'kungfu.fact-root.canonical/v2');
  assert.equal(temporal.queryBoundary.graphSearch, 'forbidden');
  assert.equal(temporal.queryBoundary.mutableHead, 'forbidden');
  assert.equal(temporal.queryBoundary.maximumDepth, 32);
  assert.equal(new Set(temporal.schemas).size, 8);

  const neutral = JSON.stringify(temporal).toLowerCase();
  for (const word of [
    'github release',
    'workflow run',
    'buildchain digest',
    'alpha channel',
    'semver',
  ]) {
    assert.equal(neutral.includes(word), false, word);
  }
});

test('the build-free source gate executes every deterministic semantic fixture', () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.ok(fixture.cases.length >= 12);
  const program = String.raw`
import importlib.util, json, pathlib
path = pathlib.Path("framework/core/tests/python/test_temporal_relation.py")
spec = importlib.util.spec_from_file_location("temporal_qualification", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
names = sorted(name for name in vars(module) if name.startswith("test_"))
for name in names:
    getattr(module, name)()
print(json.dumps({"ok": True, "tests": names}, separators=(",", ":")))
`;
  const pythonPath = [
    path.join(ROOT, 'framework/core/src/python'),
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
  const result = spawnSync(
    process.platform === 'win32' ? 'python' : 'python3',
    ['-c', program],
    {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: pythonPath },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.tests, [
    'test_all_positive_and_negative_temporal_fixtures_return_rooted_receipts',
    'test_old_cut_receipt_is_byte_stable_after_later_append_only_facts',
    'test_record_roots_bind_direction_scope_cut_and_path_order',
    'test_temporal_schemas_are_welded_to_the_independent_kfr2_registry',
  ]);
});
