// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectIssues,
  compareBaseline,
  validateRepository,
} from './check-incubation-passport.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'tests/fixtures/incubation-passport/cases.json'),
    'utf8',
  ),
);

function syntheticPassport(overrides = {}) {
  return {
    id: 'example.runtime',
    anchor: {
      type: 'runtime',
      authorityRef: 'package.json',
    },
    incubation: {
      state: 'incubating',
      deadline: '2026-07-24',
      implementationPaths: ['package.json'],
    },
    schemaOwnership: {
      class: 'none',
      registryRef: null,
      identity: null,
    },
    persistence: { policy: 'native-journal-only' },
    identityProtocol: {
      mintsRoots: false,
      implementations: [],
      vectors: [],
    },
    ...overrides,
  };
}

function keys(issues) {
  return issues.map((entry) => entry.key);
}

test('repository matches the exact known-issue baseline', () => {
  const result = validateRepository(ROOT, '2026-07-23');
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.currentIssueCount, 7);
  assert.equal(result.acceptedIssueCount, 7);
});

test('a new tracked schema fails closed', () => {
  const issues = collectIssues({
    root: ROOT,
    registry: { passports: [] },
    authority: { authorities: [] },
    schemas: ['framework/example/new_fact.fbs'],
    today: '2026-07-23',
  });
  assert.ok(keys(issues).includes(FIXTURES.cases[0].expectedIssue));
});

test('a Root protocol without two languages and vectors fails closed', () => {
  const passport = syntheticPassport({
    identityProtocol: {
      mintsRoots: true,
      implementations: [{ language: 'python', path: 'package.json' }],
      vectors: [],
    },
  });
  const issues = collectIssues({
    root: ROOT,
    registry: { passports: [passport] },
    authority: { authorities: [] },
    schemas: [],
    today: '2026-07-23',
  });
  assert.ok(keys(issues).includes(FIXTURES.cases[1].expectedIssue));
});

test('an overdue runtime incubation deadline fails closed', () => {
  const passport = syntheticPassport({
    incubation: {
      state: 'incubating',
      deadline: '2026-07-22',
      implementationPaths: ['package.json'],
    },
  });
  const issues = collectIssues({
    root: ROOT,
    registry: { passports: [passport] },
    authority: { authorities: [] },
    schemas: [],
    today: '2026-07-23',
  });
  assert.ok(keys(issues).includes(FIXTURES.cases[2].expectedIssue));
});

test('baseline comparison rejects new, stale, expired, and malformed entries', () => {
  const comparison = compareBaseline(
    [
      { key: 'known', detail: 'known' },
      { key: 'new', detail: 'new' },
    ],
    {
      issues: [
        {
          key: 'known',
          owner: 'owner',
          rationale: 'reason',
          expiresOn: '2026-07-22',
          removalCondition: 'remove',
        },
        {
          key: 'stale',
          owner: 'owner',
          rationale: 'reason',
          expiresOn: '2026-12-31',
          removalCondition: 'remove',
        },
        { key: 'malformed' },
      ],
    },
    '2026-07-23',
  );
  assert.deepEqual(keys(comparison.newIssues), ['new']);
  assert.deepEqual(
    comparison.staleBaseline.map((entry) => entry.key),
    ['stale'],
  );
  assert.deepEqual(
    comparison.expiredBaseline.map((entry) => entry.key),
    ['known'],
  );
  assert.deepEqual(comparison.malformedBaseline, ['malformed']);
});
