// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ProjectCutProductLoopReleaseError,
  verifyProjectCutProductLoopReleaseEvidence,
  verifyRetainedProjectCutProductLoopRelease,
} from './project-cut-product-loop-release.mjs';
import { runProjectCutProductLoopRelease } from './run-project-cut-product-loop-release.mjs';

const contract = JSON.parse(
  fs.readFileSync(
    'framework/work/work-loop/project-cut-product-loop.release-contract.json',
    'utf8',
  ),
);
const digest = (character) => `sha256:${character.repeat(64)}`;

function syntheticEvidence() {
  const sourceCommit = 'a'.repeat(40);
  const roots = Object.fromEntries(
    contract.requiredRootBindings.map((name, index) => [
      name,
      digest(((index + 1) % 10).toString()),
    ]),
  );
  roots.operationReceiptRoots = [digest('a')];
  const evidenceBindings = Object.fromEntries(
    contract.requiredEvidenceBindings.map((name, index) => [
      name,
      digest('bcdef01'[index]),
    ]),
  );
  evidenceBindings.surfaceParityRoot = digest('d');
  const artifacts = contract.requiredPlatforms.map((id) => ({
    id,
    digest: digest('e'),
    installCoordinate: `test:${id}:artifact`,
  }));
  return {
    schema: contract.evidenceSchema,
    reportId: 'synthetic-test-only',
    sourceCommit,
    releasePassport: {
      ref: 'buildchain:test-only',
      sourceCommit,
      digest: digest('f'),
      artifactDigests: Object.fromEntries(
        artifacts.map(({ id, digest: artifactDigest }) => [id, artifactDigest]),
      ),
    },
    scenarios: contract.requiredScenarios.map((id) => ({
      id,
      status: 'pass',
      sourceCommit,
      roots: structuredClone(roots),
      evidence: structuredClone(evidenceBindings),
    })),
    negativeCases: contract.requiredNegativeCases.map((id) => ({
      id,
      status: 'rejected',
      observedRootsRef: `test:${id}:roots`,
      unmetContract: `test:${id}:contract`,
      resolvingAuthority: `test:${id}:authority`,
      safeNextAction: `test:${id}:next`,
      evidenceRef: `test:${id}:evidence`,
    })),
    surfaceParity: {
      status: 'pass',
      surfaces: [...contract.requiredSurfaces],
      semanticRoot: digest('d'),
      evidenceRef: 'test:surface-parity',
    },
    domainProfiles: contract.requiredDomainProfileKinds.map((id) => ({
      id,
      profileId: `test:${id}`,
      status: 'pass',
      coreProductChanges: [],
      evidenceRef: `test:${id}:profile`,
    })),
    artifacts,
    independentReview: {
      status: 'approved',
      author: 'test-author',
      reviewer: 'test-reviewer',
      evidenceRef: 'test:review',
    },
    unknowns: [],
    residualRisks: [],
  };
}

function expectationsFor(evidence) {
  return {
    sourceCommit: evidence.sourceCommit,
    releasePassportDigest: evidence.releasePassport.digest,
  };
}

function syntheticPassport(evidence) {
  return {
    release: { sourceSha: evidence.sourceCommit },
    artifacts: evidence.artifacts.map((artifact) => ({
      name: `kungfu-${artifact.id}`,
      platform:
        artifact.id === 'win32' ? 'windows-test' : `${artifact.id}-test`,
      sha256: artifact.digest.slice('sha256:'.length),
    })),
  };
}

function expectCode(mutate, code) {
  const evidence = syntheticEvidence();
  mutate(evidence);
  assert.throws(
    () =>
      verifyProjectCutProductLoopReleaseEvidence(
        evidence,
        contract,
        expectationsFor(evidence),
      ),
    (error) =>
      error instanceof ProjectCutProductLoopReleaseError && error.code === code,
  );
}

test('release contract freezes the complete product-loop evidence boundary', () => {
  assert.equal(contract.status, 'not-qualified');
  assert.equal(contract.targetGate.id, 'product.project-cut-loop');
  assert.equal(contract.targetGate.registration, 'pending');
  assert.equal(contract.evidenceRunner.status, 'implemented');
  assert.equal(contract.evidenceRunner.qualifyingEvidenceAvailable, false);
  assert.equal(contract.currentClaims.qualified, false);
  assert.deepEqual(contract.requiredSurfaces, ['cli', 'agent', 'gui', 'tui']);
  assert.ok(contract.requiredScenarios.includes('third-party-domain-profile'));
  assert.ok(
    contract.currentClaims.blockers.includes(
      'executable begin, completion, and settlement remain incomplete',
    ),
  );
  assert.ok(
    contract.currentClaims.blockers.every(
      (blocker) => !/\b(?:export|import)\b/u.test(blocker),
    ),
  );
});

test('complete synthetic evidence exercises the verifier without claiming qualification', () => {
  const evidence = syntheticEvidence();
  assert.equal(
    verifyProjectCutProductLoopReleaseEvidence(
      evidence,
      contract,
      expectationsFor(evidence),
    ),
    evidence,
  );
  assert.equal(evidence.reportId, 'synthetic-test-only');
  assert.equal(contract.currentClaims.qualified, false);
});

test('missing scenario fails closed', () => {
  expectCode((evidence) => evidence.scenarios.pop(), 'SCENARIOS_INCOMPLETE');
});

test('missing GUI parity fails closed', () => {
  expectCode((evidence) => {
    evidence.surfaceParity.surfaces = ['cli', 'agent', 'tui'];
  }, 'SURFACE_PARITY_INVALID');
});

test('missing third-party profile fails closed', () => {
  expectCode((evidence) => {
    evidence.domainProfiles = evidence.domainProfiles.filter(
      ({ id }) => id !== 'third-party',
    );
  }, 'DOMAIN_PROFILES_INCOMPLETE');
});

test('third-party core product changes fail closed', () => {
  expectCode((evidence) => {
    evidence.domainProfiles.find(
      ({ id }) => id === 'third-party',
    ).coreProductChanges = ['framework/core'];
  }, 'THIRD_PARTY_CORE_CHANGE');
});

test('self-review and unknowns fail closed', () => {
  expectCode((evidence) => {
    evidence.independentReview.reviewer = evidence.independentReview.author;
  }, 'SELF_REVIEW');
  expectCode((evidence) => {
    evidence.unknowns = ['unclassified provider state'];
  }, 'UNRESOLVED_UNKNOWNS');
});

test('source and passport mismatch fails closed', () => {
  expectCode((evidence) => {
    evidence.releasePassport.sourceCommit = 'b'.repeat(40);
  }, 'PASSPORT_SOURCE_MISMATCH');
});

test('passport artifact and scenario parity mismatches fail closed', () => {
  expectCode((evidence) => {
    evidence.releasePassport.artifactDigests.linux = digest('0');
  }, 'PASSPORT_ARTIFACT_MISMATCH');
  expectCode((evidence) => {
    evidence.scenarios[0].evidence.surfaceParityRoot = digest('0');
  }, 'SURFACE_PARITY_MISMATCH');
});

test('expected source and passport are mandatory and exact', () => {
  const evidence = syntheticEvidence();
  assert.throws(
    () => verifyProjectCutProductLoopReleaseEvidence(evidence, contract),
    (error) =>
      error instanceof ProjectCutProductLoopReleaseError &&
      error.code === 'EXPECTED_SOURCE_REQUIRED',
  );
  assert.throws(
    () =>
      verifyProjectCutProductLoopReleaseEvidence(evidence, contract, {
        sourceCommit: 'b'.repeat(40),
        releasePassportDigest: evidence.releasePassport.digest,
      }),
    (error) =>
      error instanceof ProjectCutProductLoopReleaseError &&
      error.code === 'SOURCE_NOT_CURRENT',
  );
  assert.throws(
    () =>
      verifyProjectCutProductLoopReleaseEvidence(evidence, contract, {
        sourceCommit: evidence.sourceCommit,
        releasePassportDigest: digest('0'),
      }),
    (error) =>
      error instanceof ProjectCutProductLoopReleaseError &&
      error.code === 'PASSPORT_NOT_CURRENT',
  );
});

test('retained release verification binds the actual passport and artifacts', () => {
  const evidence = syntheticEvidence();
  assert.equal(
    verifyRetainedProjectCutProductLoopRelease(
      {
        evidence,
        passport: syntheticPassport(evidence),
        passportDigest: evidence.releasePassport.digest,
        passportRef: evidence.releasePassport.ref,
        sourceCommit: evidence.sourceCommit,
      },
      contract,
    ),
    evidence,
  );
});

test('retained release verification rejects passport source and ref drift', () => {
  const evidence = syntheticEvidence();
  const inputs = {
    evidence,
    passport: syntheticPassport(evidence),
    passportDigest: evidence.releasePassport.digest,
    passportRef: evidence.releasePassport.ref,
    sourceCommit: evidence.sourceCommit,
  };
  assert.throws(
    () =>
      verifyRetainedProjectCutProductLoopRelease(
        {
          ...inputs,
          passport: {
            ...inputs.passport,
            release: { sourceSha: 'b'.repeat(40) },
          },
        },
        contract,
      ),
    (error) =>
      error instanceof ProjectCutProductLoopReleaseError &&
      error.code === 'PASSPORT_SOURCE_NOT_CURRENT',
  );
  assert.throws(
    () =>
      verifyRetainedProjectCutProductLoopRelease(
        { ...inputs, passportRef: 'other/release-passport.json' },
        contract,
      ),
    (error) =>
      error instanceof ProjectCutProductLoopReleaseError &&
      error.code === 'PASSPORT_REF_MISMATCH',
  );
});

test('retained release verification rejects unbound platform artifacts', () => {
  const evidence = syntheticEvidence();
  const passport = syntheticPassport(evidence);
  passport.artifacts = passport.artifacts.filter(
    ({ platform }) => !platform.startsWith('windows-'),
  );
  assert.throws(
    () =>
      verifyRetainedProjectCutProductLoopRelease(
        {
          evidence,
          passport,
          passportDigest: evidence.releasePassport.digest,
          passportRef: evidence.releasePassport.ref,
          sourceCommit: evidence.sourceCommit,
        },
        contract,
      ),
    (error) =>
      error instanceof ProjectCutProductLoopReleaseError &&
      error.code === 'PASSPORT_ARTIFACT_NOT_BOUND',
  );
});

test('executable runner derives source and emits digest-bound Shifu evidence', (t) => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-project-cut-loop-runner-'),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'framework', 'work', 'work-loop'), {
    recursive: true,
  });
  fs.copyFileSync(
    'framework/work/work-loop/project-cut-product-loop.release-contract.json',
    path.join(
      root,
      'framework',
      'work',
      'work-loop',
      'project-cut-product-loop.release-contract.json',
    ),
  );
  fs.writeFileSync(path.join(root, 'seed.txt'), 'committed source\n');
  childProcess.execFileSync('git', ['init', '-q'], { cwd: root });
  childProcess.execFileSync('git', ['add', 'seed.txt'], { cwd: root });
  childProcess.execFileSync(
    'git',
    [
      '-c',
      'user.name=Kungfu Test',
      '-c',
      'user.email=test@kungfu.link',
      'commit',
      '-q',
      '-m',
      'test: seed source',
    ],
    { cwd: root },
  );
  const sourceCommit = childProcess
    .execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
    .trim();
  const qualification = path.join(root, 'qualification');
  fs.mkdirSync(qualification);
  const evidence = syntheticEvidence();
  evidence.sourceCommit = sourceCommit;
  for (const scenario of evidence.scenarios)
    scenario.sourceCommit = sourceCommit;
  evidence.releasePassport.sourceCommit = sourceCommit;
  evidence.releasePassport.ref = 'qualification/buildchain.release.json';
  const passport = syntheticPassport(evidence);
  const passportFile = path.join(qualification, 'buildchain.release.json');
  fs.writeFileSync(passportFile, `${JSON.stringify(passport, null, 2)}\n`);
  evidence.releasePassport.digest = `sha256:${crypto
    .createHash('sha256')
    .update(fs.readFileSync(passportFile))
    .digest('hex')}`;
  const evidenceFile = path.join(
    qualification,
    'project-cut-product-loop.json',
  );
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
  const gateEvidenceFile = path.join(root, '.gate', 'evidence.json');

  const result = runProjectCutProductLoopRelease({
    root,
    evidencePath: evidenceFile,
    passportPath: passportFile,
    gateEvidenceFile,
  });

  assert.equal(result.verification, 'pass');
  assert.equal(result.sourceCommit, sourceCommit);
  assert.equal(result.targetGate.registration, 'pending');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(gateEvidenceFile, 'utf8')).pointers.map(
      ({ id, ref }) => ({ id, ref }),
    ),
    [
      {
        id: 'project-cut-product-loop-report',
        ref: 'qualification/project-cut-product-loop.json',
      },
      {
        id: 'buildchain-release-passport',
        ref: 'qualification/buildchain.release.json',
      },
    ],
  );
});
