// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { auditAdrRegistry } from './adr-audit.mjs';

const releaseContract = {
  stable: {
    requiredDecisionStatuses: ['accepted'],
    admittedImplementationStatuses: ['implemented', 'not-applicable'],
    requireQualificationForImplemented: true,
  },
};

function record(overrides = {}) {
  return {
    id: 'ADR-0001',
    owner: 'kungfu',
    file: 'docs/adr/ADR-0001-example.md',
    decisionStatus: 'accepted',
    implementationStatus: 'implemented',
    reviewState: 'maintainer-reviewed',
    implementationCommits: ['a'.repeat(40)],
    implementationPrs: [],
    closureCommit: 'a'.repeat(40),
    closurePr: '',
    qualificationRefs: ['tests/example.test.mjs'],
    supersedes: [],
    supersededBy: [],
    ...overrides,
  };
}

test('admits fully qualified Core and Shifu records under one policy', () => {
  const report = auditAdrRegistry({
    records: [
      record(),
      record({
        id: 'SHIFU-ADR-0001',
        owner: 'shifu',
        file: 'docs/adr/SHIFU-ADR-0001-example.md',
      }),
    ],
    releaseContract,
    metadataContract: { adrEvidence: { legacyEvidenceExemptions: {} } },
    release: 'stable',
    strict: true,
  });
  assert.equal(report.ok, true);
  assert.equal(report.summary.owners.kungfu, 1);
  assert.equal(report.summary.owners.shifu, 1);
  assert.equal(report.summary.stableAdmitted, 2);
});

test('reports status debt by default and fails strict or stable qualification', () => {
  const records = [
    record({
      implementationStatus: 'unknown',
      reviewState: 'legacy-unreviewed',
      qualificationRefs: [],
    }),
    record({
      id: 'SHIFU-ADR-0001',
      owner: 'shifu',
      file: 'docs/adr/SHIFU-ADR-0001-example.md',
      implementationStatus: 'partial',
      reviewState: 'unreviewed',
      qualificationRefs: [],
    }),
  ];
  const baseline = auditAdrRegistry({ records, releaseContract });
  assert.equal(baseline.ok, true);
  assert.equal(baseline.summary.stableBlocked, 2);
  assert.ok(baseline.debt.some((item) => item.kind === 'review-debt'));

  const strict = auditAdrRegistry({ records, releaseContract, strict: true });
  assert.equal(strict.ok, false);

  const stable = auditAdrRegistry({
    records,
    releaseContract,
    release: 'stable',
  });
  assert.equal(stable.ok, false);
});

test('fails on structural findings even when release obligations are admitted', () => {
  const report = auditAdrRegistry({
    records: [record()],
    releaseContract,
    structuralFindings: [
      {
        code: 'adr-index-missing',
        file: 'docs/adr/README.md',
        line: 1,
        message: 'missing record',
      },
    ],
  });
  assert.equal(report.ok, false);
  assert.equal(report.summary.structuralFindings, 1);
});

test('excludes terminal decisions from stable obligations', () => {
  const report = auditAdrRegistry({
    records: [
      record({
        decisionStatus: 'superseded',
        implementationStatus: 'not-applicable',
        qualificationRefs: [],
      }),
      record({
        id: 'ADR-0002',
        decisionStatus: 'rejected',
        implementationStatus: 'not-applicable',
        qualificationRefs: [],
      }),
      record({
        id: 'ADR-0003',
        decisionStatus: 'withdrawn',
        implementationStatus: 'not-applicable',
        qualificationRefs: [],
      }),
    ],
    releaseContract,
    release: 'stable',
  });
  assert.equal(report.ok, true);
  assert.equal(report.summary.stableBlocked, 0);
});
