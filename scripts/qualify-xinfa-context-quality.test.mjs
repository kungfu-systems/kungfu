#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { verifyRetainedReceipt } from './qualify-xinfa-context-quality.mjs';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function signedReceipt(overrides = {}) {
  const content = {
    schema: 'xinfa.context-quality-qualification/v1',
    actor: 'context-quality-v1',
    verdict: 'pass',
    atlas_root: `sha256:${'1'.repeat(64)}`,
    corpus_root: `sha256:${'2'.repeat(64)}`,
    cut_root: `sha256:${'3'.repeat(64)}`,
    thresholds: { cases: 31, critical_source_recall: 1 },
    metrics: { cases: 31, critical_source_recall: 1 },
    outcomes: [],
    ...overrides,
  };
  return {
    ...content,
    qualification_root: `sha256:${crypto
      .createHash('sha256')
      .update(`${JSON.stringify(canonical(content))}\n`)
      .digest('hex')}`,
  };
}

test('accepts a valid retained baseline for a different candidate Atlas root', () => {
  const retained = signedReceipt();
  const current = signedReceipt({ atlas_root: `sha256:${'4'.repeat(64)}` });
  assert.doesNotThrow(() => verifyRetainedReceipt(retained, current));
});

test('rejects a forged retained qualification root', () => {
  const retained = signedReceipt();
  retained.metrics.cases = 0;
  assert.throws(
    () => verifyRetainedReceipt(retained, signedReceipt()),
    /receipt root is invalid/,
  );
});

test('rejects corpus and threshold drift across a moving-main candidate', () => {
  assert.throws(
    () =>
      verifyRetainedReceipt(
        signedReceipt(),
        signedReceipt({ corpus_root: `sha256:${'5'.repeat(64)}` }),
      ),
    /corpus drifted/,
  );
  assert.throws(
    () =>
      verifyRetainedReceipt(
        signedReceipt(),
        signedReceipt({ thresholds: { cases: 32 } }),
      ),
    /thresholds drifted/,
  );
});
