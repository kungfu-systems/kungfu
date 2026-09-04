// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticRoot } from '../contract.mjs';
import { classifyBuildCoreShadow } from './index.mjs';

function evidence(overrides = {}) {
  const stdoutRoot = semanticRoot('same stdout');
  const stderrRoot = semanticRoot('');
  return {
    command: ['./shifu', 'build:core'],
    environment: { KUNGFU_BUILD_PROFILE: 'journal' },
    state: 'succeeded',
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputExceeded: false,
    stdoutRoot,
    stderrRoot,
    outputRoot: semanticRoot({ stdoutRoot, stderrRoot }),
    evidenceRoot: semanticRoot({ lane: 'test' }),
    ...overrides,
  };
}

function classification(result, dimension) {
  return result.find((item) => item.dimension === dimension).classification;
}

test('exact successful build lanes classify as parity', () => {
  const result = classifyBuildCoreShadow(evidence(), evidence());
  assert.equal(classification(result, 'command'), 'parity');
  assert.equal(classification(result, 'environment'), 'parity');
  assert.equal(classification(result, 'exit'), 'parity');
  assert.equal(classification(result, 'output'), 'parity');
  assert.equal(classification(result, 'receipt'), 'parity');
});

test('successful output differences are retained as explainable nondeterminism', () => {
  const result = classifyBuildCoreShadow(
    evidence(),
    evidence({ stdoutRoot: semanticRoot('warm-cache stdout') }),
  );
  assert.equal(classification(result, 'exit'), 'parity');
  assert.equal(classification(result, 'output'), 'explainable-nondeterminism');
});

test('exit mismatch is executor drift and bounded-output failure is a blocker', () => {
  const drift = classifyBuildCoreShadow(
    evidence(),
    evidence({ state: 'failed', exitCode: 7 }),
  );
  assert.equal(classification(drift, 'exit'), 'executor-drift');
  assert.equal(classification(drift, 'output'), 'executor-drift');

  const blocked = classifyBuildCoreShadow(
    evidence({ outputExceeded: true }),
    evidence(),
  );
  assert.equal(classification(blocked, 'exit'), 'blocker');

  const matchedFailure = classifyBuildCoreShadow(
    evidence({ state: 'failed', exitCode: 7 }),
    evidence({ state: 'failed', exitCode: 7 }),
  );
  assert.equal(classification(matchedFailure, 'exit'), 'blocker');
  assert.equal(classification(matchedFailure, 'receipt'), 'blocker');
});
