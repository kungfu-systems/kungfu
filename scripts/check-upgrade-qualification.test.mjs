// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { buildQualificationEvidence } from './run-upgrade-native-qualification.mjs';
import {
  UpgradeQualificationError,
  artifactSignatureStatement,
  checkUpgradeQualification,
  verifyUpgradeQualificationEvidence,
} from './upgrade-qualification.mjs';

const ROOT = process.cwd();
const CONTRACT = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      'framework/upgrade/kungfu-upgrade-qualification.contract.json',
    ),
    'utf8',
  ),
);
const FIXTURES = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, 'tests/fixtures/upgrade-qualification/cases.json'),
    'utf8',
  ),
).cases;

function signedFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const manifest = {
    schema: 'kungfu.product-upgrade.manifest/v1',
    productVersion: '4.0.0-alpha.1',
    sourceCommit: 'a'.repeat(40),
    platform: 'darwin',
    architecture: 'arm64',
    qualificationEvidenceRef: 'buildchain:upgrade-qualification/run-1',
    artifacts: [
      {
        kind: 'runtime',
        url: 'https://example.invalid/runtime.tar.zst',
        size: 7,
        digest: `sha256:${'1'.repeat(64)}`,
        signature: 'retained:signature/runtime',
      },
      {
        kind: 'desktop',
        url: 'https://example.invalid/Kungfu.dmg',
        size: 11,
        digest: `sha256:${'2'.repeat(64)}`,
        signature: 'retained:signature/desktop',
      },
    ],
  };
  const evidence = {
    schema: CONTRACT.evidenceSchema,
    evidenceRef: manifest.qualificationEvidenceRef,
    sourceCommit: manifest.sourceCommit,
    productVersion: manifest.productVersion,
    platform: manifest.platform,
    architecture: manifest.architecture,
    tier: 'native-packaged',
    surfaces: ['runtime', 'desktop'],
    runtimeChurnIterations: 128,
    checks: Object.fromEntries(
      CONTRACT.requiredChecks.map((name) => [name, true]),
    ),
    artifacts: manifest.artifacts.map((artifact) => ({
      kind: artifact.kind,
      digest: artifact.digest,
      size: artifact.size,
      signatureEvidenceRef: artifact.signature,
      algorithm: 'ed25519',
      publicKeyPem,
      signature: sign(
        null,
        artifactSignatureStatement(
          manifest,
          artifact,
          manifest.qualificationEvidenceRef,
        ),
        privateKey,
      ).toString('base64'),
    })),
  };
  return { manifest, evidence };
}

function mutate(name, fixture) {
  const value = structuredClone(fixture);
  if (name === 'none') return value;
  if (name === 'missing-evidence') return { ...value, evidence: null };
  if (name === 'source-only-tier') value.evidence.tier = 'source-fixture';
  else if (name === 'source-mismatch')
    value.evidence.sourceCommit = 'b'.repeat(40);
  else if (name === 'surface-missing') value.evidence.surfaces = ['runtime'];
  else if (name === 'runtime-churn-insufficient')
    value.evidence.runtimeChurnIterations = 99;
  else if (name === 'messages-unqualified')
    value.evidence.checks.messageRegistry = false;
  else if (name === 'docs-unqualified')
    value.evidence.checks.manualAnchors = false;
  else if (name === 'signature-missing') value.evidence.artifacts.pop();
  else if (name === 'signature-invalid')
    value.evidence.artifacts[0].signature = 'AA==';
  else if (name === 'artifact-digest-mismatch')
    value.evidence.artifacts[0].digest = `sha256:${'f'.repeat(64)}`;
  else throw new Error(`unknown fixture mutation: ${name}`);
  return value;
}

test('upgrade qualification contract keeps messages, docs, and platform claims welded', () => {
  const result = checkUpgradeQualification();
  assert.equal(result.fixtures, FIXTURES.length);
  assert.ok(result.messages >= 13);
  assert.equal(result.platforms, 3);
});

test('native campaign evidence signs every retained artifact without persisting a private key', () => {
  const { manifest } = signedFixture();
  manifest.artifacts.push({
    kind: 'cli',
    url: 'https://example.invalid/kungfu-cli.tar.gz',
    size: 13,
    digest: `sha256:${'3'.repeat(64)}`,
    signature: 'retained:signature/cli',
  });
  const evidence = buildQualificationEvidence({
    manifest,
    contract: CONTRACT,
    nativeSigning: { kind: 'fixture' },
    generatedAt: '2026-07-15T00:00:00.000Z',
  });
  assert.deepEqual(evidence.surfaces, ['runtime', 'desktop', 'cli']);
  assert.equal(evidence.artifacts.length, 3);
  assert.equal('privateKey' in evidence, false);
  assert.equal(
    verifyUpgradeQualificationEvidence(manifest, evidence, 'cli', CONTRACT),
    evidence,
  );
});

for (const fixtureCase of FIXTURES) {
  test(`upgrade qualification fixture: ${fixtureCase.id}`, () => {
    const { manifest, evidence } = mutate(
      fixtureCase.mutation,
      signedFixture(),
    );
    if (fixtureCase.admitted) {
      assert.equal(
        verifyUpgradeQualificationEvidence(
          manifest,
          evidence,
          'desktop',
          CONTRACT,
        ),
        evidence,
      );
      return;
    }
    assert.throws(
      () =>
        verifyUpgradeQualificationEvidence(
          manifest,
          evidence,
          'desktop',
          CONTRACT,
        ),
      (error) =>
        error instanceof UpgradeQualificationError &&
        error.code === fixtureCase.code,
    );
  });
}
