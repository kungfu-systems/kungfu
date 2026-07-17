// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cacheEvidenceFromMembers,
  nearestRank,
  report,
  selectedContext,
  summarize,
  validateBaseline,
} from './measure-dev-required-latency.mjs';

function cacheReceipt(layer, outcome, overrides = {}) {
  return JSON.stringify({
    schema: 'buildchain.portable-dev-cache-receipt/v1',
    layer,
    outcome,
    usable: ['exact', 'compatible'].includes(outcome),
    qualified: ['exact', 'compatible', 'miss'].includes(outcome),
    coldFallbackRequired: outcome === 'miss',
    coldFallbackStatus: outcome === 'miss' ? 'passed' : 'not-run',
    sourceSha: 'abc',
    receiptDigest: `sha256:${layer}`,
    ...overrides,
  });
}

test('nearest-rank percentiles preserve the observed tail', () => {
  assert.equal(nearestRank([100, 200, 300, 400], 0.5), 200);
  assert.equal(nearestRank([100, 200, 300, 400], 0.95), 400);
  assert.equal(nearestRank([], 0.95), null);
});

test('an under-sized passing window remains non-qualifying', () => {
  const sample = {
    excluded: false,
    durationMs: 120000,
    classification: { kind: 'native' },
  };
  const value = report('owner/repo', 'dev', ['required'], [sample]);
  assert.equal(value.verdict.qualified, false);
  assert.match(value.verdict.reason, /insufficient/);
});

test('portable cache receipts distinguish warm compatibility from cold fallback', () => {
  const warm = cacheEvidenceFromMembers(
    {
      'cache/dependency.receipt.json': cacheReceipt('dependency', 'compatible'),
      'cache/compiler.receipt.json': cacheReceipt('compiler', 'exact'),
      'cache/compiler-stats.txt': [
        'Cacheable calls:     91 /  91 (100.0%)',
        '  Hits:              91 /  91 (100.0%)',
        '  Misses:             0 /  91 ( 0.00%)',
      ].join('\n'),
    },
    { kind: 'native' },
  );
  assert.equal(warm.outcome, 'compatible');
  assert.equal(warm.warm, true);
  assert.deepEqual(warm.compilerStats, {
    cacheableCalls: 91,
    hits: 91,
    misses: 0,
    hitRatio: 1,
  });

  const cold = cacheEvidenceFromMembers(
    {
      'cache/dependency.receipt.json': cacheReceipt('dependency', 'miss'),
      'cache/compiler.receipt.json': cacheReceipt('compiler', 'miss'),
    },
    { kind: 'native' },
  );
  assert.equal(cold.outcome, 'miss');
  assert.equal(cold.cold, true);
});

test('missing or invalid cache receipts remain unknown', () => {
  const value = cacheEvidenceFromMembers({}, { kind: 'native' });
  assert.equal(value.outcome, 'unknown');
  assert.match(value.reason, /missing dependency receipt/);
});

test('a cache miss without a passed cold fallback remains unknown', () => {
  const value = cacheEvidenceFromMembers(
    {
      'cache/dependency.receipt.json': cacheReceipt('dependency', 'miss', {
        coldFallbackStatus: 'failed',
      }),
      'cache/compiler.receipt.json': cacheReceipt('compiler', 'miss'),
    },
    { kind: 'native' },
  );
  assert.equal(value.outcome, 'unknown');
  assert.match(value.reason, /passed fallback/);
});

test('non-native samples explicitly have no portable cache work', () => {
  const value = cacheEvidenceFromMembers({}, { kind: 'non-native' });
  assert.equal(value.outcome, 'not-applicable');
  assert.equal(value.authority, 'source-planner');
});

test('a passing latency window still requires complete native cache evidence', () => {
  const records = Array.from({ length: 20 }, (_, index) => ({
    excluded: false,
    durationMs: 120000,
    classification: { kind: 'native' },
    cache:
      index === 0
        ? { outcome: 'unknown', warm: false, cold: false }
        : { outcome: 'compatible', warm: true, cold: false },
  }));
  const incomplete = report('owner/repo', 'dev', ['required'], records);
  assert.equal(incomplete.verdict.qualified, false);
  assert.match(incomplete.verdict.reason, /cache evidence is incomplete/);

  records[0].cache = { outcome: 'miss', warm: false, cold: true };
  const complete = report('owner/repo', 'dev', ['required'], records);
  assert.equal(complete.verdict.qualified, true);
  assert.equal(complete.cache.warmCount, 19);
  assert.equal(complete.cache.coldCount, 1);
});

test('summary reports sample count and queue-inclusive distribution', () => {
  assert.deepEqual(
    summarize([
      { durationMs: 120000 },
      { durationMs: 300000 },
      { durationMs: 700000 },
    ]),
    { sampleCount: 3, p50Ms: 300000, p95Ms: 700000, maxMs: 700000 },
  );
});

test('context duration starts at the workflow run creation time', () => {
  const context = selectedContext(
    [
      {
        id: 7,
        name: 'required',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-07-17T00:03:00Z',
        completed_at: '2026-07-17T00:05:00Z',
        details_url: 'https://github.com/owner/repo/actions/runs/42/job/7',
      },
    ],
    [{ id: 42, created_at: '2026-07-17T00:00:00Z' }],
    'required',
  );
  assert.equal(context.startAuthority, 'workflow.created_at');
  assert.equal(context.durationMs, 300000);
  assert.equal(context.queueMs, 180000);
});

test('live required contexts must match the retained baseline authority', () => {
  const baseline = {
    $schema: 'kungfu.dev-required-latency-baseline/v1',
    requiredContexts: ['a', 'b'],
  };
  assert.equal(validateBaseline(baseline, ['b', 'a']), true);
  assert.throws(
    () => validateBaseline(baseline, ['a', 'c']),
    /live required contexts drifted/,
  );
});
