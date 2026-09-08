// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateMeasurementCoverage } from './check-kungfu-gate-catalog.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINDINGS = 'docs/qualification/gates/workflow-bindings.json';
const COVERAGE = 'docs/qualification/gates/measurement-coverage.json';

test('historical controller timing remains bound to its exact source, receipt, and adapter', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const coverage = JSON.parse(
    fs.readFileSync(path.join(ROOT, COVERAGE), 'utf8'),
  );
  const files = [
    BINDINGS,
    COVERAGE,
    ...coverage.measurements.flatMap((record) =>
      record.observations.map((observation) => observation.receipt),
    ),
  ];
  for (const file of new Set(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), target);
  }
  const registry = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'shifu.gates.json'), 'utf8'),
  );
  const original = JSON.parse(
    fs.readFileSync(path.join(root, BINDINGS), 'utf8'),
  );
  assert.deepEqual(validateMeasurementCoverage(root, registry).issues, []);
  for (const tamper of [
    (entry) => {
      entry.sourceSha = '0'.repeat(40);
    },
    (entry) => {
      entry.receipt = 'different-receipt.json';
    },
    (entry) => {
      entry.adapter.uses = entry.adapter.uses.replace(/@.+$/, '@v4-alpha');
    },
  ]) {
    const document = structuredClone(original);
    const binding = document.bindings.find(
      (entry) => entry.id === 'dev-candidate-buildchain-config',
    );
    tamper(binding.measurementHistory[0]);
    fs.writeFileSync(path.join(root, BINDINGS), JSON.stringify(document));
    assert.ok(
      validateMeasurementCoverage(root, registry).issues.some((issue) =>
        issue.includes('controller binding identity is stale'),
      ),
    );
  }
});
