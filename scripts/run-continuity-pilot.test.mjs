// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runPilot,
  validatePublicProjection,
  validateReportPair,
} from './run-continuity-pilot.mjs';

function clone(value) {
  return structuredClone(value);
}

test('runs one bounded preparatory pilot and generates animation inputs', () => {
  const output = fs.mkdtempSync(
    path.join(os.tmpdir(), 'continuity-pilot-test-'),
  );
  const result = runPilot({
    output,
    sourceHead: '1111111111111111111111111111111111111111',
    runId: 'test-run',
  });
  assert.equal(result.baseline.verdict, 'unsupported');
  assert.equal(result.baseline.oracle.passed, false);
  assert.equal(result.kungfu.verdict, 'pass');
  assert.equal(result.kungfu.oracle.passed, true);
  assert.equal(result.kungfu.reset.continuationSource, 'durable-fact');
  assert.equal(result.projection.evidenceClass, 'preparatory');
  assert.equal(result.animation.durationSeconds, 32);
  for (const file of [
    'baseline-report.json',
    'kungfu-report.json',
    'raw-evidence-index.json',
    'public-projection.json',
    'animation-pack.json',
  ]) {
    assert.equal(fs.existsSync(path.join(output, file)), true, file);
  }
});

test('rejects hidden transcript injection', () => {
  const result = runPilot({
    sourceHead: '2222222222222222222222222222222222222222',
    runId: 'hidden-transcript',
  });
  const baseline = clone(result.baseline);
  baseline.reset.hiddenTranscriptInjected = true;
  assert.throws(
    () => validateReportPair({ baseline, kungfu: result.kungfu }),
    /hidden transcript injection/,
  );
});

test('rejects different task trees', () => {
  const result = runPilot({
    sourceHead: '3333333333333333333333333333333333333333',
    runId: 'tree-mismatch',
  });
  const kungfu = clone(result.kungfu);
  kungfu.fixture.initialTreeRoot = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () => validateReportPair({ baseline: result.baseline, kungfu }),
    /same initial tree root/,
  );
});

test('rejects missing baseline identity and missing oracle', () => {
  const result = runPilot({
    sourceHead: '4444444444444444444444444444444444444444',
    runId: 'missing-identity',
  });
  const baseline = clone(result.baseline);
  baseline.runIdentity.id = '';
  assert.throws(
    () => validateReportPair({ baseline, kungfu: result.kungfu }),
    /baseline run identity/,
  );
  const kungfu = clone(result.kungfu);
  kungfu.oracle.root = '';
  assert.throws(
    () => validateReportPair({ baseline: result.baseline, kungfu }),
    /kungfu oracle/,
  );
});

test('rejects fabricated public metrics', () => {
  const result = runPilot({
    sourceHead: '5555555555555555555555555555555555555555',
    runId: 'fabricated-metric',
  });
  const projection = clone(result.projection);
  projection.observed.speedup = '10x';
  assert.throws(
    () => validatePublicProjection(projection),
    /fabricated or forbidden public metric/,
  );
});

test('rejects smoke evidence presented as FO10', () => {
  const result = runPilot({
    sourceHead: '6666666666666666666666666666666666666666',
    runId: 'smoke-as-fo10',
  });
  const kungfu = clone(result.kungfu);
  kungfu.claimClass = 'FO10';
  assert.throws(
    () => validateReportPair({ baseline: result.baseline, kungfu }),
    /smoke cannot be presented as FO10/,
  );
});
