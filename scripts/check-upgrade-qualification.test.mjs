// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildQualificationEvidence,
  verifyWindows,
} from './run-upgrade-native-qualification.mjs';
import {
  UpgradeQualificationError,
  artifactSignatureStatement,
  checkUpgradeQualification,
  qualificationContentRoot,
  updateCampaignRoot,
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
    releaseChannel: 'alpha',
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
  const candidateReleasePassportRoot = `sha256:${'8'.repeat(64)}`;
  const campaign = {
    schema: CONTRACT.campaignSchema,
    generatedAt: new Date().toISOString(),
    evidenceTier: CONTRACT.promotionTier,
    cleanEnvironment: true,
    publicClaim: { advertised: true, mechanicsOnly: false },
    channel: manifest.releaseChannel,
    platform: manifest.platform,
    architecture: manifest.architecture,
    installSource: 'archive',
    installOwner: CONTRACT.installSources.archive.owner,
    action: CONTRACT.installSources.archive.action,
    previousPublic: {
      productVersion: '4.0.0-alpha.0',
      sourceCommit: '9'.repeat(40),
      channelIndexRoot: `sha256:${'3'.repeat(64)}`,
      releasePassportRoot: `sha256:${'4'.repeat(64)}`,
      manifestRoot: `sha256:${'5'.repeat(64)}`,
      artifactRoot: `sha256:${'6'.repeat(64)}`,
    },
    candidate: {
      productVersion: manifest.productVersion,
      sourceCommit: manifest.sourceCommit,
      channelIndexRoot: `sha256:${'7'.repeat(64)}`,
      releasePassportRoot: candidateReleasePassportRoot,
      manifestRoot: qualificationContentRoot(manifest),
      artifactRoot: qualificationContentRoot(
        manifest.artifacts.map(
          ({ kind, url, size, digest, signature: signatureEvidence }) => ({
            kind,
            url,
            size,
            digest,
            signature: signatureEvidence,
          }),
        ),
      ),
    },
    invocation: {
      argv: ['kungfu', 'update'],
      confirmationCount: 1,
    },
    result: {
      state: 'complete',
      observedVersion: manifest.productVersion,
      receiptRoot: `sha256:${'a'.repeat(64)}`,
      smokeChecks: Object.fromEntries(
        CONTRACT.requiredSmokeChecks.map((name) => [name, true]),
      ),
    },
    activation: {
      activeWorkContinues: true,
      existingWorkRuntime: 'previous-pinned',
      newWorkActivation: 'fenced-safe-point-or-next-command',
      supervisorActionRequired: false,
    },
    faults: CONTRACT.requiredFaults.map((id, index) => ({
      id,
      verdict: index % 2 === 0 ? 'no-mutation' : 'recoverable',
      previousAuthorityRetained: true,
      receiptRoot: `sha256:${(index + 1).toString(16).padStart(64, '0')}`,
      recoveryAction: 'retry-the-exact-plan',
    })),
    nonClaims: {
      powerLossDurability: false,
      maliciousTamperRecovery: false,
      uninterruptedActiveWork: false,
    },
    documentationPaths: [...CONTRACT.documentation.requiredPaths],
  };
  campaign.campaignRoot = updateCampaignRoot(campaign);
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
    campaigns: [campaign],
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
  return { manifest, evidence, candidateReleasePassportRoot };
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
  else if (name === 'campaign-missing') value.evidence.campaigns = [];
  else if (name === 'campaign-source-mismatch')
    value.evidence.campaigns[0].candidate.sourceCommit = 'b'.repeat(40);
  else if (name === 'campaign-channel-root-missing')
    value.evidence.campaigns[0].candidate.channelIndexRoot = '';
  else if (name === 'campaign-artifact-root-mismatch')
    value.evidence.campaigns[0].candidate.artifactRoot = `sha256:${'f'.repeat(64)}`;
  else if (name === 'campaign-passport-mismatch')
    value.evidence.campaigns[0].candidate.releasePassportRoot = `sha256:${'f'.repeat(64)}`;
  else if (name === 'campaign-previous-public-invalid')
    value.evidence.campaigns[0].previousPublic.productVersion =
      value.evidence.campaigns[0].candidate.productVersion;
  else if (name === 'campaign-platform-mismatch')
    value.evidence.campaigns[0].platform = 'linux';
  else if (name === 'campaign-owner-mismatch')
    value.evidence.campaigns[0].installOwner = 'transported-channel';
  else if (name === 'campaign-command-mismatch')
    value.evidence.campaigns[0].invocation.argv = ['sh', '-c', 'kungfu update'];
  else if (name === 'campaign-confirmation-unbounded')
    value.evidence.campaigns[0].invocation.confirmationCount = 2;
  else if (name === 'campaign-result-mismatch')
    value.evidence.campaigns[0].result.observedVersion = '4.0.0-alpha.0';
  else if (name === 'campaign-smoke-missing')
    value.evidence.campaigns[0].result.smokeChecks.runAgent = false;
  else if (name === 'campaign-activation-mismatch')
    value.evidence.campaigns[0].activation.supervisorActionRequired = true;
  else if (name === 'campaign-fault-missing')
    value.evidence.campaigns[0].faults =
      value.evidence.campaigns[0].faults.filter(
        ({ id }) => id !== 'network-interruption',
      );
  else if (name === 'campaign-nonclaim-mismatch')
    value.evidence.campaigns[0].nonClaims.powerLossDurability = true;
  else if (name === 'campaign-docs-missing')
    value.evidence.campaigns[0].documentationPaths =
      value.evidence.campaigns[0].documentationPaths.filter(
        (item) => item !== 'README.md',
      );
  else if (name === 'campaign-simulated')
    value.evidence.campaigns[0].evidenceTier = 'source-fixture';
  else if (name === 'campaign-stale')
    value.evidence.campaigns[0].generatedAt = '2020-01-01T00:00:00.000Z';
  else throw new Error(`unknown fixture mutation: ${name}`);
  if (value.evidence?.campaigns?.[0]) {
    value.evidence.campaigns[0].campaignRoot = updateCampaignRoot(
      value.evidence.campaigns[0],
    );
  }
  return value;
}

test('upgrade qualification contract keeps messages, docs, and platform claims welded', () => {
  const result = checkUpgradeQualification();
  assert.equal(result.fixtures, FIXTURES.length);
  assert.ok(result.messages >= 13);
  assert.equal(result.platforms, 3);
});

test('Windows Alpha native evidence accepts exact unsigned PE bytes', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-unsigned-windows-'),
  );
  try {
    const installer = path.join(
      root,
      'product',
      'release',
      'desktop',
      'kungfu-setup.exe',
    );
    const executable = path.join(
      root,
      'product',
      'dist',
      'desktop',
      'Kungfu.exe',
    );
    fs.mkdirSync(path.dirname(installer), { recursive: true });
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(installer, Buffer.from('MZunsigned-installer'));
    fs.writeFileSync(executable, Buffer.from('MZunsigned-application'));
    const evidence = verifyWindows(root, {
      artifacts: [
        {
          kind: 'desktop',
          url: 'https://example.invalid/kungfu-setup.exe',
        },
      ],
    });
    assert.deepEqual(evidence, {
      kind: 'unsigned-pe',
      installer: true,
      executable: true,
      platformCodeSigning: false,
      artifactIntegrity: 'signed-channel-digest',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('native campaign evidence signs every retained artifact without persisting a private key', () => {
  const { manifest, evidence: fixtureEvidence } = signedFixture();
  manifest.artifacts.push({
    kind: 'cli',
    url: 'https://example.invalid/kungfu-cli.tar.gz',
    size: 13,
    digest: `sha256:${'3'.repeat(64)}`,
    signature: 'retained:signature/cli',
  });
  const campaign = fixtureEvidence.campaigns[0];
  campaign.candidate.manifestRoot = qualificationContentRoot(manifest);
  campaign.candidate.artifactRoot = qualificationContentRoot(
    manifest.artifacts.map(
      ({ kind, url, size, digest, signature: signatureEvidence }) => ({
        kind,
        url,
        size,
        digest,
        signature: signatureEvidence,
      }),
    ),
  );
  campaign.campaignRoot = updateCampaignRoot(campaign);
  const evidence = buildQualificationEvidence({
    manifest,
    contract: CONTRACT,
    nativeSigning: { kind: 'fixture' },
    campaigns: [campaign],
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
    const { manifest, evidence, candidateReleasePassportRoot } = mutate(
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
          { releasePassportRoot: candidateReleasePassportRoot },
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
          { releasePassportRoot: candidateReleasePassportRoot },
        ),
      (error) =>
        error instanceof UpgradeQualificationError &&
        error.code === fixtureCase.code,
    );
  });
}
