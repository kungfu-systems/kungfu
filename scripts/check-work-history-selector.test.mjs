// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { semanticRoot } from '../framework/work/project-cut/index.mjs';
import {
  buildWorkHistoryCandidate,
  buildWorkHistoryIndexSnapshot,
  buildWorkHistorySelectionPolicy,
  selectWorkHistory,
  verifyWorkHistorySelectionManifest,
} from '../framework/work/work-history-selector/src/work-history-selector.mjs';
import { checkWorkHistorySelectorContract } from '../framework/work/work-history-selector/tooling/work-history-selector-contract.mjs';

const AS_OF = '2026-07-29T08:00:00Z';
const AUTHORITY_ROOT = semanticRoot({ authority: 'work-control' });
const SOURCE_ROOT = semanticRoot({ source: 'native-history' });
const SOURCE_CUT_ROOT = semanticRoot({ cut: 'history-index' });
const RECORD_SCHEMA = 'kungfu.assignment-orchestration.status/v1';

function candidate(seed, overrides = {}) {
  const base = {
    recordSchema: RECORD_SCHEMA,
    authority: { root: AUTHORITY_ROOT, status: 'current' },
    source: {
      id: 'native-work-history',
      root: SOURCE_ROOT,
      status: 'current',
      visibility: 'internal',
    },
    temporal: {
      availableAt: '2026-07-29T06:30:00Z',
      indexedAt: '2026-07-29T07:00:00Z',
      completedAt: '2026-07-29T06:00:00Z',
    },
    supersession: {
      status: 'active',
      at: null,
      replacementRoot: null,
    },
    invalidation: { status: 'valid', at: null, evidenceRoot: null },
    applicability: 'comparable',
    evidenceRoots: [semanticRoot({ evidence: seed })],
    ranking: { score: 50 },
  };
  return buildWorkHistoryCandidate({
    ...base,
    ...overrides,
    authority: { ...base.authority, ...overrides.authority },
    source: { ...base.source, ...overrides.source },
    temporal: { ...base.temporal, ...overrides.temporal },
    supersession: { ...base.supersession, ...overrides.supersession },
    invalidation: { ...base.invalidation, ...overrides.invalidation },
    ranking: { ...base.ranking, ...overrides.ranking },
  });
}

function request(candidates, overrides = {}) {
  const indexSnapshot =
    overrides.indexSnapshot ??
    buildWorkHistoryIndexSnapshot({
      capturedAt: '2026-07-29T07:30:00Z',
      sourceCutRoot: SOURCE_CUT_ROOT,
    });
  const policy =
    overrides.policy ??
    buildWorkHistorySelectionPolicy({
      id: 'advisory-history-v1',
      version: 1,
      maxSelected: 8,
      recentWindowSeconds: 86400,
      maximumIndexAgeSeconds: 7200,
      allowedAuthorityRoots: [AUTHORITY_ROOT],
      allowedRecordSchemas: [RECORD_SCHEMA],
      allowedSourceIds: ['native-work-history'],
      allowedVisibilities: ['internal'],
    });
  return {
    schema: 'kungfu.work-history.selection-request/v1',
    objectiveRoot: semanticRoot({ objective: 'design-work' }),
    xinfaRoot: semanticRoot({ xinfa: 'current' }),
    asOf: AS_OF,
    indexSnapshot,
    policy,
    candidates,
  };
}

test('selector contract roots schemas and the advisory-only boundary', () => {
  const result = checkWorkHistorySelectorContract();
  assert.equal(result.schemaFiles, 2);
  assert.match(result.schemaRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.contractRoot, /^sha256:[0-9a-f]{64}$/u);
});

test('same candidate set reproduces selection, ordering, and root', () => {
  const current = candidate('current', {
    applicability: 'current-objective',
    ranking: { score: 1 },
  });
  const high = candidate('high', { ranking: { score: 90 } });
  const low = candidate('low', { ranking: { score: 10 } });
  const first = selectWorkHistory(request([low, current, high]));
  const second = selectWorkHistory(request([high, low, current]));
  assert.equal(first.ok, true);
  assert.equal(first.manifest.status, 'complete');
  assert.deepEqual(first.manifest.included, second.manifest.included);
  assert.equal(first.manifest.selectionRoot, second.manifest.selectionRoot);
  assert.deepEqual(
    first.manifest.included.map((entry) => entry.candidateRoot),
    [current.candidateRoot, high.candidateRoot, low.candidateRoot],
  );
  assert.equal(verifyWorkHistorySelectionManifest(first.manifest).ok, true);
  assert.deepEqual(first.manifest.advisory, {
    readOnly: true,
    workAuthority: false,
    mayMutateAssignments: false,
  });

  const reRootedAuthorityDrift = structuredClone(first.manifest);
  reRootedAuthorityDrift.advisory.readOnly = false;
  const { selectionRoot: _selectionRoot, ...authorityDriftPreimage } =
    reRootedAuthorityDrift;
  reRootedAuthorityDrift.selectionRoot = semanticRoot(authorityDriftPreimage);
  const authorityVerification = verifyWorkHistorySelectionManifest(
    reRootedAuthorityDrift,
  );
  assert.equal(authorityVerification.ok, false);
  assert.ok(
    authorityVerification.diagnostics.some(
      (entry) => entry.code === 'advisory-boundary-mismatch',
    ),
  );

  const reRootedCountDrift = structuredClone(first.manifest);
  reRootedCountDrift.coverage.includedCount += 1;
  const { selectionRoot: _countRoot, ...countDriftPreimage } =
    reRootedCountDrift;
  reRootedCountDrift.selectionRoot = semanticRoot(countDriftPreimage);
  const countVerification =
    verifyWorkHistorySelectionManifest(reRootedCountDrift);
  assert.equal(countVerification.ok, false);
  assert.ok(
    countVerification.diagnostics.some(
      (entry) => entry.code === 'coverage-count-mismatch',
    ),
  );

  const malformedReference = structuredClone(first.manifest);
  malformedReference.sourceReferences[0].sourceId = null;
  const malformedVerification =
    verifyWorkHistorySelectionManifest(malformedReference);
  assert.equal(malformedVerification.ok, false);
  assert.ok(
    malformedVerification.diagnostics.some(
      (entry) => entry.path === '$.sourceReferences[0].sourceId',
    ),
  );
});

test('temporal leakage, stale index, and invalidation after index fail closed', () => {
  const future = candidate('future', {
    temporal: { availableAt: '2026-07-29T09:00:00Z' },
  });
  const leaked = selectWorkHistory(request([future]));
  assert.equal(leaked.manifest.included.length, 0);
  assert.deepEqual(leaked.manifest.excluded[0].reasons, ['temporal-leakage']);

  const postIndex = candidate('post-index', {
    temporal: {
      availableAt: '2026-07-29T07:45:00Z',
      indexedAt: '2026-07-29T07:00:00Z',
    },
  });
  const postIndexResult = selectWorkHistory(request([postIndex]));
  assert.deepEqual(postIndexResult.manifest.excluded[0].reasons, [
    'temporal-order-invalid',
  ]);

  const unobservedAtIndex = candidate('unobserved-at-index', {
    temporal: {
      availableAt: '2026-07-29T07:20:00Z',
      indexedAt: '2026-07-29T07:40:00Z',
    },
  });
  const unobservedResult = selectWorkHistory(request([unobservedAtIndex]));
  assert.deepEqual(unobservedResult.manifest.excluded[0].reasons, [
    'index-temporal-mismatch',
  ]);

  const staleSnapshot = buildWorkHistoryIndexSnapshot({
    capturedAt: '2026-07-28T01:00:00Z',
    sourceCutRoot: SOURCE_CUT_ROOT,
  });
  const stale = selectWorkHistory(
    request([candidate('stale-index')], { indexSnapshot: staleSnapshot }),
  );
  assert.equal(stale.manifest.status, 'incomplete');
  assert.equal(stale.manifest.included.length, 0);
  assert.ok(stale.manifest.coverage.gaps.includes('stale-index-snapshot'));

  const justOverAgeLimit = buildWorkHistoryIndexSnapshot({
    capturedAt: '2026-07-29T05:59:59.999Z',
    sourceCutRoot: SOURCE_CUT_ROOT,
  });
  const millisecondStale = selectWorkHistory(
    request([candidate('millisecond-stale')], {
      indexSnapshot: justOverAgeLimit,
    }),
  );
  assert.ok(
    millisecondStale.manifest.coverage.gaps.includes('stale-index-snapshot'),
  );

  const invalidated = candidate('post-index-invalidation', {
    invalidation: {
      status: 'invalidated',
      at: '2026-07-29T07:45:00Z',
      evidenceRoot: semanticRoot({ invalidation: 'post-index' }),
    },
  });
  const invalidation = selectWorkHistory(request([invalidated]));
  assert.deepEqual(invalidation.manifest.excluded[0].reasons, [
    'invalidation-after-index',
  ]);
  assert.ok(
    invalidation.manifest.coverage.gaps.includes('index-missed-invalidation'),
  );
});

test('ambiguous authority, missing evidence, supersession, and private raw input stay excluded', () => {
  const cases = [
    [
      candidate('authority', {
        authority: { status: 'ambiguous' },
      }),
      'ambiguous-authority',
      'unknown-applicability',
    ],
    [
      candidate('missing', {
        source: { status: 'missing' },
      }),
      'missing-or-unapproved-source',
      'unknown-applicability',
    ],
    [
      candidate('missing-evidence', {
        evidenceRoots: [],
      }),
      'missing-evidence',
      'unknown-applicability',
    ],
    [
      candidate('superseded', {
        supersession: {
          status: 'superseded',
          at: '2026-07-29T07:00:00Z',
          replacementRoot: semanticRoot({ replacement: 1 }),
        },
      }),
      'superseded',
      'superseded-or-invalidated',
    ],
    [
      candidate('private', {
        source: { visibility: 'private-raw' },
      }),
      'privacy-denied',
      'unknown-applicability',
    ],
  ];
  const result = selectWorkHistory(request(cases.map(([entry]) => entry)));
  assert.equal(result.manifest.included.length, 0);
  for (const [entry, reason, classification] of cases) {
    const excluded = result.manifest.excluded.find(
      (item) => item.candidateRoot === entry.candidateRoot,
    );
    assert.equal(excluded.classification, classification);
    assert.deepEqual(excluded.reasons, [reason]);
  }
});

test('schema drift and candidate-root tampering reject the request without a manifest', () => {
  const wrongSchema = candidate('wrong-schema', {
    recordSchema: 'unknown.record/v1',
  });
  const schemaResult = selectWorkHistory(request([wrongSchema]));
  assert.equal(schemaResult.ok, true);
  assert.deepEqual(schemaResult.manifest.excluded[0].reasons, [
    'schema-incompatible',
  ]);

  const tampered = structuredClone(candidate('tampered'));
  tampered.ranking.score += 1;
  const rootResult = selectWorkHistory(request([tampered]));
  assert.equal(rootResult.ok, false);
  assert.equal(rootResult.manifest, null);
  assert.ok(
    rootResult.diagnostics.some((entry) => entry.code === 'root-mismatch'),
  );
});

test('equal ranking uses candidate root as the deterministic final tie-break', () => {
  const left = candidate('left');
  const right = candidate('right');
  const result = selectWorkHistory(request([right, left]));
  const expected = [left.candidateRoot, right.candidateRoot].sort();
  assert.deepEqual(
    result.manifest.included.map((entry) => entry.candidateRoot),
    expected,
  );
});
