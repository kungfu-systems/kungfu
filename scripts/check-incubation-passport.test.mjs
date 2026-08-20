// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  collectIssues,
  compareBaseline,
  protectedSourceRetained,
  validateAdmissionFixture,
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

test('repository matches the exact known-issue baseline', async () => {
  const result = await validateRepository(ROOT, '2026-07-23');
  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.currentIssueCount, 5);
  assert.equal(result.acceptedIssueCount, 5);
});

test('repository baseline lifecycle fails before expiry with an actionable continuation', async () => {
  const results = new Map();
  for (const fixture of FIXTURES.clockCases) {
    const result = await validateRepository(ROOT, fixture.today);
    results.set(fixture.name, result);
    assert.equal(result.ok, fixture.expectedOk, fixture.name);
    assert.equal(
      result.expiringBaseline.length,
      fixture.expectedExpiring,
      fixture.name,
    );
    assert.equal(
      result.expiredBaseline.length,
      fixture.expectedExpired,
      fixture.name,
    );
  }

  const nearExpiry = results.get('near-expiry');
  assert.ok(
    nearExpiry.expiringBaseline.every(
      (entry) => entry.owner && entry.removalCondition,
    ),
  );
});

test('repository baseline lifecycle fails closed for an impossible clock date', async () => {
  const result = await validateRepository(ROOT, '2026-02-31');
  assert.equal(result.ok, false);
  assert.ok(
    result.structuralErrors.some((entry) => entry.includes('real UTC date')),
  );
});

test('admitted native receipt rejects stale and incomplete evidence', () => {
  const registry = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, 'framework/incubation/incubation-passport.registry.json'),
      'utf8',
    ),
  );
  const passport = registry.passports.find(
    (entry) => entry.id === 'kungfu.work-control-l3',
  );
  const fixture = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, passport.identityProtocol.admissionReceipt),
      'utf8',
    ),
  );
  assert.deepEqual(
    validateAdmissionFixture({ root: ROOT, passport, fixture }),
    [],
  );

  const stale = structuredClone(fixture);
  stale.protectedSource.tree = '0'.repeat(40);
  assert.ok(
    validateAdmissionFixture({ root: ROOT, passport, fixture: stale }).some(
      (entry) => entry.includes('protected source tree does not match'),
    ),
  );

  const incomplete = structuredClone(fixture);
  Reflect.deleteProperty(incomplete.receipt.journal, 'replayEvidenceRoot');
  assert.ok(
    validateAdmissionFixture({
      root: ROOT,
      passport,
      fixture: incomplete,
    }).some((entry) =>
      entry.includes('receipt journal has an invalid field set'),
    ),
  );

  const forgedReplay = structuredClone(fixture);
  forgedReplay.materials.replay.evidence.journal.genTimeDecimal =
    '1787054299172351543';
  assert.ok(
    validateAdmissionFixture({
      root: ROOT,
      passport,
      fixture: forgedReplay,
    }).some((entry) =>
      entry.includes('native replay evidence Root is invalid'),
    ),
  );

  const ciAttributedReplay = structuredClone(fixture);
  ciAttributedReplay.materials.replay.workflowRun = 32126612532;
  ciAttributedReplay.materials.replay.job = 95679020015;
  ciAttributedReplay.materials.replay.provenance.ciExecution = {
    workflowRun: 32126612532,
    job: 95679020015,
  };
  const ciAttributionErrors = validateAdmissionFixture({
    root: ROOT,
    passport,
    fixture: ciAttributedReplay,
  });
  assert.ok(
    ciAttributionErrors.some((entry) =>
      entry.includes('replay evidence has an invalid field set'),
    ),
  );
  assert.ok(
    ciAttributionErrors.some((entry) =>
      entry.includes('cannot claim CI execution coordinates'),
    ),
  );

  const detachedCapture = structuredClone(fixture);
  detachedCapture.materials.replay.provenance.source.tree = '0'.repeat(40);
  assert.ok(
    validateAdmissionFixture({
      root: ROOT,
      passport,
      fixture: detachedCapture,
    }).some((entry) =>
      entry.includes('capture is detached from the protected source'),
    ),
  );

  const forgedCaptureTime = structuredClone(fixture);
  forgedCaptureTime.materials.replay.provenance.journalGeneratedAt =
    '2026-08-18T11:26:45.000000000Z';
  assert.ok(
    validateAdmissionFixture({
      root: ROOT,
      passport,
      fixture: forgedCaptureTime,
    }).some((entry) =>
      entry.includes('provenance time does not match journal genTime'),
    ),
  );

  const forgedService = structuredClone(fixture);
  forgedService.materials.serviceContractRoot = `sha256:${'0'.repeat(64)}`;
  assert.ok(
    validateAdmissionFixture({
      root: ROOT,
      passport,
      fixture: forgedService,
    }).some((entry) =>
      entry.includes('native service contract Root is invalid'),
    ),
  );

  const escapingMaterial = structuredClone(fixture);
  escapingMaterial.materials.contract.path = '../../package.json';
  assert.ok(
    validateAdmissionFixture({
      root: ROOT,
      passport,
      fixture: escapingMaterial,
    }).some((entry) => entry.includes('escapes the checkout')),
  );
});

test('protected source accepts ordinary retained ancestry without recovery', () => {
  const sourceSha = 'a'.repeat(40);
  assert.equal(
    protectedSourceRetained({
      sourceSha,
      gitIsAncestor: (ancestor, descendant) => {
        assert.equal(ancestor, sourceSha);
        assert.equal(descendant, 'HEAD');
        return true;
      },
      gitRead: () => assert.fail('ordinary ancestry must not inspect an event'),
      hydrateMergeGroupBase: () =>
        assert.fail('ordinary ancestry must not hydrate history'),
    }),
    true,
  );
});

test('protected source recovers ancestry from the exact merge-group base', () => {
  const sourceSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const headSha = 'c'.repeat(40);
  const ancestryCalls = [];
  const hydrated = [];
  assert.equal(
    protectedSourceRetained({
      sourceSha,
      env: {
        GITHUB_EVENT_NAME: 'merge_group',
        GITHUB_EVENT_PATH: '/event.json',
      },
      readFile: () =>
        JSON.stringify({
          merge_group: { base_sha: baseSha, head_sha: headSha },
        }),
      gitIsAncestor: (ancestor, descendant) => {
        ancestryCalls.push([ancestor, descendant]);
        return descendant === baseSha;
      },
      gitRead: (args) => {
        assert.deepEqual(args, ['rev-parse', 'HEAD']);
        return headSha;
      },
      hydrateMergeGroupBase: (sha) => {
        hydrated.push(sha);
        return true;
      },
    }),
    true,
  );
  assert.deepEqual(ancestryCalls, [
    [sourceSha, 'HEAD'],
    [sourceSha, baseSha],
  ]);
  assert.deepEqual(hydrated, [baseSha]);
});

test('protected source rejects mismatched or unretained merge-group evidence', () => {
  const sourceSha = 'a'.repeat(40);
  const baseSha = 'b'.repeat(40);
  const headSha = 'c'.repeat(40);
  const event = {
    GITHUB_EVENT_NAME: 'merge_group',
    GITHUB_EVENT_PATH: '/event.json',
  };
  const readFile = () =>
    JSON.stringify({
      merge_group: { base_sha: baseSha, head_sha: headSha },
    });

  assert.equal(
    protectedSourceRetained({
      sourceSha,
      env: event,
      readFile,
      gitIsAncestor: () => false,
      gitRead: () => 'd'.repeat(40),
      hydrateMergeGroupBase: () =>
        assert.fail('mismatched event must not hydrate history'),
    }),
    false,
  );
  assert.equal(
    protectedSourceRetained({
      sourceSha,
      env: event,
      readFile,
      gitIsAncestor: () => false,
      gitRead: () => headSha,
      hydrateMergeGroupBase: () => true,
    }),
    false,
  );
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
  assert.deepEqual(comparison.expiringBaseline, []);
  assert.deepEqual(comparison.malformedBaseline, ['malformed']);
});
