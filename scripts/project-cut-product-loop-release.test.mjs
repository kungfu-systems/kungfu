// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  ProjectCutProductLoopReleaseError,
  verifyProjectCutProductLoopReleaseEvidence,
} from './project-cut-product-loop-release.mjs';

const contract = JSON.parse(
  fs.readFileSync(
    'framework/work-loop/project-cut-product-loop.release-contract.json',
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
  assert.equal(contract.currentClaims.qualified, false);
  assert.deepEqual(contract.requiredSurfaces, ['cli', 'agent', 'gui', 'tui']);
  assert.ok(contract.requiredScenarios.includes('third-party-domain-profile'));
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
