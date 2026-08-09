// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { auditAdrRegistry, legacyAdrIdentityFindings } from './adr-audit.mjs';

function cleanGitEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
}

const releaseContract = {
  stable: {
    requiredDecisionStatuses: ['accepted'],
    admittedImplementationStatuses: ['implemented', 'not-applicable'],
    requireQualificationForImplemented: true,
  },
};

function record(overrides = {}) {
  return {
    id: 'KF-ADR-019f86da-4f90-7179-a900-c40bdb498910',
    owner: 'kungfu',
    file: 'docs/adr/KF-ADR-019f86da-4f90-7179-a900-c40bdb498910-example.md',
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

test('rejects retired sequential identity tokens outside immutable history', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-adr-token-'));
  t.after(() => fs.rmSync(root, { recursive: true }));
  childProcess.execFileSync('git', ['init', '-q'], {
    cwd: root,
    env: cleanGitEnvironment(),
  });
  const token = ['ADR', '0042'].join('-');
  fs.writeFileSync(path.join(root, 'current.txt'), `${token}\n`);
  fs.mkdirSync(path.join(root, '.xinfa/baselines/example'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, '.xinfa/baselines/example/history.txt'),
    `${token}\n`,
  );
  childProcess.execFileSync('git', ['add', '-f', '.'], {
    cwd: root,
    env: cleanGitEnvironment(),
  });
  const findings = legacyAdrIdentityFindings(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, 'current.txt');
  assert.equal(findings[0].code, 'adr-sequential-identity-token');
});

test('admits fully qualified Core and Shifu records under one policy', () => {
  const report = auditAdrRegistry({
    records: [
      record(),
      record({
        id: 'SHIFU-ADR-019f86da-4f90-7179-a900-c40bdb498910',
        owner: 'shifu',
        file: 'docs/adr/SHIFU-ADR-019f86da-4f90-7179-a900-c40bdb498910-example.md',
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
      id: 'SHIFU-ADR-019f86da-4f90-7179-a900-c40bdb498910',
      owner: 'shifu',
      file: 'docs/adr/SHIFU-ADR-019f86da-4f90-7179-a900-c40bdb498910-example.md',
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
        id: 'KF-ADR-019f86da-4f90-7a55-9b15-93fcab44a33a',
        decisionStatus: 'rejected',
        implementationStatus: 'not-applicable',
        qualificationRefs: [],
      }),
      record({
        id: 'KF-ADR-019f86da-4f90-7a30-8697-5c648120053d',
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
