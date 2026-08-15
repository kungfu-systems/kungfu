// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { cliQualificationRoot } from '../product/scripts/cli-surface-qualification.mjs';
import {
  PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
  PRODUCT_UPGRADE_PUBLICATION_ADMISSION_SCHEMA,
  PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
  PRODUCT_UPGRADE_PUBLICATION_CAPSULE_SCHEMA,
  promotableUpgradePlatforms,
  verifyUpgradePublicationAdmission,
  verifyUpgradePublicationPayloads,
  writeUpgradePublicationAdmission,
} from './upgrade-publication-admission.mjs';
import {
  artifactSignatureStatement,
  loadUpgradeQualificationContract,
  qualificationContentRoot,
  updateCampaignRoot,
} from './upgrade-qualification.mjs';

const VERSION = '4.0.0-alpha.1';
const SOURCE = 'a'.repeat(40);
const RUNTIME = 'd'.repeat(40);
const CERTIFICATE_SHA1 = 'c5d8ff5100e8f3cd6c30da6c88495d4c03e5b43f';
const CONTRACT = loadUpgradeQualificationContract();
const RELEASE_CANDIDATE_PASSPORT = {
  contract: 'kungfu-buildchain-release-candidate-passport',
  source: { headSha: SOURCE, mergeRefSha: 'b'.repeat(40) },
};
const RELEASE_CANDIDATE_PASSPORT_ROOT = qualificationContentRoot(
  RELEASE_CANDIDATE_PASSPORT,
);

test('upgrade publication claims only advertised promotion-eligible platforms', () => {
  assert.deepEqual(promotableUpgradePlatforms(CONTRACT), []);
  assert.deepEqual(
    promotableUpgradePlatforms({
      currentClaims: {
        win32: { advertised: true, promotionEligible: false },
        linux: { advertised: true, promotionEligible: true },
        darwin: { advertised: false, promotionEligible: true },
      },
    }),
    ['linux'],
  );
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function contentRoot(value) {
  return `sha256:${sha256(JSON.stringify(canonical(value)))}`;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function rewriteCliQualification(filePath, mutate) {
  const report = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  Reflect.deleteProperty(report, 'qualificationRoot');
  mutate(report);
  report.qualificationRoot = cliQualificationRoot(report);
  writeJson(filePath, report);
}

function cliQualification(platform, architecture, archive, archiveBytes) {
  const qualificationPlatform = platform === 'win32' ? 'windows' : platform;
  const platformId = `${qualificationPlatform}-${architecture}`;
  const body = {
    schema: 'kungfu.cli-installed-product-qualification/v1',
    qualified: true,
    label: 'cli-archive',
    identity: {
      archive,
      archiveSha256: `sha256:${sha256(archiveBytes)}`,
      sourceCommit: SOURCE,
    },
    platform: platformId,
    architecture,
    version: VERSION,
    claims: { installedProduct: true, qualifiedPlatform: platformId },
    productIdentity: { verifiedFromInstalledCommand: true },
    checks: {
      kfd3: { linkedApiCount: 1 },
      mutationPlanReceipt: {
        planReplayStable: true,
        receiptVerified: true,
      },
    },
    isolation: {
      sourceCheckoutRequired: false,
      guiPrivateStateRequired: false,
    },
    nonClaims: [
      ...(qualificationPlatform === 'darwin'
        ? ['Linux', 'Windows']
        : qualificationPlatform === 'linux'
          ? ['macOS', 'Windows']
          : ['macOS', 'Linux']
      ).map((candidate) => `${candidate} is not qualified by this receipt.`),
      'Availability metadata does not activate a KFX contribution.',
    ],
  };
  return { ...body, qualificationRoot: cliQualificationRoot(body) };
}

function signedEvidence(manifest) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
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
      releasePassportRoot: RELEASE_CANDIDATE_PASSPORT_ROOT,
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
    invocation: { argv: ['kungfu', 'update'], confirmationCount: 1 },
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
  return {
    schema: CONTRACT.evidenceSchema,
    evidenceRef: manifest.qualificationEvidenceRef,
    sourceCommit: manifest.sourceCommit,
    productVersion: manifest.productVersion,
    platform: manifest.platform,
    architecture: manifest.architecture,
    tier: CONTRACT.promotionTier,
    surfaces: manifest.artifacts.map((artifact) => artifact.kind),
    runtimeChurnIterations: CONTRACT.minimumRuntimeChurnIterations,
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
}

function platformFixture(root, platform, architecture) {
  const bundleRoot = path.join(root, 'payloads', `kungfu-${platform}`);
  const releaseRoot = path.join(bundleRoot, 'product', 'release');
  const desktopName =
    platform === 'win32'
      ? `Kungfu-${platform}.exe`
      : platform === 'linux'
        ? `Kungfu-${platform}.AppImage`
        : `Kungfu-${platform}.zip`;
  const cliName =
    platform === 'win32'
      ? `kungfu-episodes-cli-windows-${architecture}.zip`
      : `kungfu-episodes-cli-${platform}-${architecture}.tar.gz`;
  const desktopBytes = Buffer.from(`desktop-${platform}`);
  const cliBytes = Buffer.from(`cli-${platform}`);
  const desktopPath = path.join(releaseRoot, 'desktop', desktopName);
  const cliPath = path.join(releaseRoot, 'cli', cliName);
  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(desktopPath, desktopBytes);
  fs.writeFileSync(cliPath, cliBytes);
  const cliQualificationPath = path.join(
    releaseRoot,
    'cli',
    `kungfu-episodes-cli-${platform === 'win32' ? 'windows' : platform}-${architecture}.qualification.json`,
  );
  writeJson(
    cliQualificationPath,
    cliQualification(platform, architecture, cliName, cliBytes),
  );
  const manifest = {
    schema: 'kungfu.product-upgrade.manifest/v1',
    productVersion: VERSION,
    releaseChannel: 'alpha',
    sourceCommit: SOURCE,
    platform,
    architecture,
    qualificationEvidenceRef: `buildchain:qualification/${platform}`,
    artifacts: [
      {
        kind: 'runtime',
        url: 'app-resource://kungfu',
        size: 7,
        digest: `sha256:${'1'.repeat(64)}`,
        signature: `retained:signature/${platform}/runtime`,
      },
      {
        kind: 'desktop',
        url: `https://example.invalid/${desktopName}`,
        size: desktopBytes.length,
        digest: `sha256:${sha256(desktopBytes)}`,
        signature: `retained:signature/${platform}/desktop`,
      },
      {
        kind: 'cli',
        url: `https://example.invalid/${cliName}`,
        size: cliBytes.length,
        digest: `sha256:${sha256(cliBytes)}`,
        signature: `retained:signature/${platform}/cli`,
      },
    ],
  };
  const manifestName = `kungfu-upgrade-${VERSION}-${platform}-${architecture}.json`;
  const desktopManifestPath = path.join(releaseRoot, 'desktop', manifestName);
  const cliManifestPath = path.join(releaseRoot, 'cli', manifestName);
  const evidencePath = path.join(
    releaseRoot,
    'qualification',
    CONTRACT.publication.evidenceFileName,
  );
  writeJson(desktopManifestPath, manifest);
  writeJson(cliManifestPath, manifest);
  writeJson(evidencePath, signedEvidence(manifest));
  writeJson(path.join(bundleRoot, 'manifest.json'), {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-artifact',
    artifactName: `kungfu-${platform}-${SOURCE}`,
    platform: { id: `${platform}-${architecture}` },
  });
  return {
    bundleRoot,
    desktopPath,
    cliPath,
    cliQualificationPath,
    desktopManifestPath,
    cliManifestPath,
    evidencePath,
  };
}

function finalizeDarwinCliFixture(value) {
  const platform = value.platforms.darwin;
  const finalBytes = Buffer.from('signed-notarized-cli-darwin');
  fs.writeFileSync(platform.cliPath, finalBytes);
  rewriteCliQualification(platform.cliQualificationPath, (report) => {
    report.identity.archiveSha256 = `sha256:${sha256(finalBytes)}`;
  });
  const providerPath = path.join(
    platform.bundleRoot,
    '.buildchain',
    'artifacts',
    'signing',
    'macos-arm64',
    'kungfu-cli-macos-arm64',
    'provider-evidence.json',
  );
  writeJson(providerPath, {
    contract: 'kungfu-buildchain-apple-developer-id-evidence/v1',
    status: 'passed',
    artifactKind: 'archive',
    certificateSha1: CERTIFICATE_SHA1,
    teamId: 'RYNFD6L6DK',
    notarization: {
      status: 'Accepted',
    },
  });
  const inventoryPath = path.join(
    platform.bundleRoot,
    '.buildchain',
    'artifacts',
    'macos-arm64',
    'manifest.json',
  );
  const files = [platform.cliPath, providerPath]
    .map((filePath) => ({
      path: path
        .relative(platform.bundleRoot, filePath)
        .split(path.sep)
        .join('/'),
      size: fs.statSync(filePath).size,
      sha256: sha256(fs.readFileSync(filePath)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  writeJson(inventoryPath, {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-artifact',
    platform: { id: 'macos-arm64' },
    git: { sha: SOURCE },
    expectedArtifacts: { ok: true },
    files,
    summary: {
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      digest: 'f'.repeat(64),
    },
  });
  return finalBytes;
}

function credentialManifest(root, bundleRoot, evidencePath, dmgPath, zipPath) {
  const files = [dmgPath, evidencePath, zipPath]
    .map((filePath) => ({
      path: path.relative(bundleRoot, filePath).split(path.sep).join('/'),
      size: fs.statSync(filePath).size,
      sha256: sha256(fs.readFileSync(filePath)),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  const platform = {
    id: 'macos-arm64-credential',
    name: 'macos-arm64 credential island',
    os: 'macos',
    arch: 'arm64',
  };
  const artifactName = `kungfu-macos-credential-${SOURCE}`;
  const manifest = {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-artifact',
    artifactName,
    platform,
    git: {
      repository: 'kungfu-systems/kungfu',
      sha: SOURCE,
      ref: 'refs/heads/alpha/v4/v4.0',
      runId: '123',
      runAttempt: '1',
    },
    lifecycle: {
      stage: 'credential-island',
      commandSource: 'buildchain-action',
      executed: true,
    },
    summary: {
      contract: 'kungfu-buildchain-artifact-summary',
      artifactName,
      platform,
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
      digest: digest.digest('hex'),
    },
    expectedArtifacts: {
      ok: true,
      source: 'buildchain.macos-credential-island-evidence/v1',
      checks: [
        {
          name: 'signed-output-count',
          ok: true,
          detail: '3 >= 3',
        },
      ],
    },
    files,
  };
  writeJson(path.join(bundleRoot, 'manifest.json'), manifest);
}

function credentialFixture(root) {
  const bundleRoot = path.join(
    root,
    'payloads',
    `kungfu-macos-credential-${SOURCE}`,
  );
  const releaseRoot = path.join(bundleRoot, 'product', 'release');
  const dmgPath = path.join(
    releaseRoot,
    `Kungfu-Episodes-${VERSION}-macos-arm64.dmg`,
  );
  const zipPath = path.join(
    releaseRoot,
    `Kungfu-Episodes-${VERSION}-macos-arm64.zip`,
  );
  fs.mkdirSync(releaseRoot, { recursive: true });
  fs.writeFileSync(dmgPath, 'signed-notarized-dmg');
  fs.writeFileSync(zipPath, 'signed-notarized-zip');
  const evidencePath = path.join(
    releaseRoot,
    'credential-island-evidence.json',
  );
  const evidence = {
    schema: 'buildchain.macos-credential-island-evidence/v1',
    status: 'accepted',
    startedAt: '2026-07-23T00:00:00.000Z',
    completedAt: '2026-07-23T00:01:00.000Z',
    source: {
      repository: 'kungfu-systems/kungfu',
      sha: SOURCE,
      treeSha: 'e'.repeat(40),
    },
    buildchain: { runtimeSha: RUNTIME },
    input: {
      manifestSha256: `sha256:${'1'.repeat(64)}`,
      archiveSha256: `sha256:${'2'.repeat(64)}`,
      archiveBytes: 4096,
    },
    app: {
      bundleId: 'com.kungfu.app',
      productName: 'Kungfu Episodes',
      version: VERSION,
      architecture: 'arm64',
    },
    identity: {
      certificateSha1: CERTIFICATE_SHA1,
      certificateSubject:
        'Developer ID Application: Kungfu Technology (Hong Kong) Limited (RYNFD6L6DK)',
      teamId: 'RYNFD6L6DK',
      entitlementsProfile: 'electron-desktop-v1',
      entitlementsSha256: `sha256:${'3'.repeat(64)}`,
    },
    notarization: {
      application: {
        id: '11111111-1111-1111-1111-111111111111',
        status: 'Accepted',
      },
      diskImage: {
        id: '22222222-2222-2222-2222-222222222222',
        status: 'Accepted',
      },
    },
    verification: {
      codesignStrict: true,
      hardenedRuntime: true,
      appStaple: true,
      appGatekeeper: true,
      dmgStaple: true,
      dmgGatekeeper: true,
    },
    artifacts: [
      {
        kind: 'zip',
        name: path.basename(zipPath),
        bytes: fs.statSync(zipPath).size,
        sha256: `sha256:${sha256(fs.readFileSync(zipPath))}`,
      },
      {
        kind: 'dmg',
        name: path.basename(dmgPath),
        bytes: fs.statSync(dmgPath).size,
        sha256: `sha256:${sha256(fs.readFileSync(dmgPath))}`,
      },
    ],
    runner: { os: 'darwin', arch: 'arm64', image: 'macos-15-arm64' },
  };
  writeJson(evidencePath, evidence);
  credentialManifest(root, bundleRoot, evidencePath, dmgPath, zipPath);
  return {
    bundleRoot,
    dmgPath,
    zipPath,
    evidencePath,
    manifestPath: path.join(bundleRoot, 'manifest.json'),
  };
}

function supportFixture(root) {
  const bundleRoot = path.join(root, 'payloads', 'kungfu-linux-arm64-core');
  writeJson(path.join(bundleRoot, 'manifest.json'), {
    schemaVersion: 1,
    contract: 'kungfu-buildchain-artifact',
    artifactName: `kungfu-linux-arm64-${SOURCE}`,
    platform: { id: 'linux-arm64' },
  });
  fs.writeFileSync(path.join(bundleRoot, 'core-qualification.txt'), 'passed\n');
  const cliRoot = path.join(bundleRoot, 'product', 'release', 'cli');
  const cliName = 'kungfu-episodes-cli-linux-arm64.tar.gz';
  const cliPath = path.join(cliRoot, cliName);
  const cliBytes = Buffer.from('cli-linux-arm64');
  fs.mkdirSync(cliRoot, { recursive: true });
  fs.writeFileSync(cliPath, cliBytes);
  const cliQualificationPath = path.join(
    cliRoot,
    'kungfu-episodes-cli-linux-arm64.qualification.json',
  );
  writeJson(
    cliQualificationPath,
    cliQualification('linux', 'arm64', cliName, cliBytes),
  );
  return { bundleRoot, cliPath, cliQualificationPath };
}

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-upgrade-publication-'),
  );
  const passportPath = path.join(
    root,
    'passport',
    'release-candidate-passport.json',
  );
  writeJson(passportPath, RELEASE_CANDIDATE_PASSPORT);
  const platforms = {
    darwin: platformFixture(root, 'darwin', 'arm64'),
    linux: platformFixture(root, 'linux', 'x64'),
    win32: platformFixture(root, 'win32', 'x64'),
  };
  const credential = credentialFixture(root);
  const support = supportFixture(root);
  return {
    root,
    payloadRoot: path.join(root, 'payloads'),
    passportPath,
    platforms,
    credential,
    support,
  };
}

function verify(value) {
  return verifyUpgradePublicationPayloads({
    payloadRoot: value.payloadRoot,
    releaseCandidatePassportPath: value.passportPath,
    expectedVersion: VERSION,
  });
}

function withFixture(callback) {
  const value = fixture();
  try {
    callback(value);
  } finally {
    fs.rmSync(value.root, { recursive: true, force: true });
  }
}

test('publication admission verifies a complete four-platform CLI payload plus authoritative signed macOS bytes', () => {
  withFixture((value) => {
    const admitted = verify(value);
    assert.deepEqual(admitted.platforms, [
      'darwin-arm64',
      'linux-x64',
      'win32-x64',
    ]);
    assert.deepEqual(
      admitted.manifests.map(
        ({ platform, architecture }) => `${platform}-${architecture}`,
      ),
      ['darwin-arm64', 'linux-x64', 'win32-x64'],
    );
    assert.equal(
      admitted.manifests.every(({ manifestPath }) =>
        path.isAbsolute(manifestPath),
      ),
      true,
    );
    assert.equal(
      admitted.manifests.every(
        ({ manifest }) =>
          manifest?.schema === 'kungfu.product-upgrade.manifest/v1',
      ),
      true,
    );
    assert.equal(
      admitted.credentialIsland.platformId,
      'macos-arm64-credential',
    );
    assert.equal(admitted.credentialIsland.runtimeSha, RUNTIME);
    assert.equal(admitted.credentialIsland.certificateSha1, CERTIFICATE_SHA1);
    assert.equal(admitted.releasePassportRoot, RELEASE_CANDIDATE_PASSPORT_ROOT);
    assert.deepEqual(
      admitted.cliArtifacts.map(({ platformId }) => platformId),
      ['darwin-arm64', 'linux-arm64', 'linux-x64', 'windows-x64'],
    );
    const linuxArm64 = admitted.cliArtifacts.find(
      ({ platformId }) => platformId === 'linux-arm64',
    );
    assert.deepEqual(
      {
        archive: linuxArm64.archive.name,
        platform: linuxArm64.platform,
        architecture: linuxArm64.architecture,
        version: linuxArm64.version,
        sourceCommit: linuxArm64.sourceCommit,
        digest: linuxArm64.archive.digest,
      },
      {
        archive: 'kungfu-episodes-cli-linux-arm64.tar.gz',
        platform: 'linux',
        architecture: 'arm64',
        version: VERSION,
        sourceCommit: SOURCE,
        digest: `sha256:${sha256(fs.readFileSync(value.support.cliPath))}`,
      },
    );
    assert.equal(admitted.campaignRoots.length, 3);
    assert.deepEqual(admitted.channelIndexRoots, [`sha256:${'7'.repeat(64)}`]);
    assert.equal(
      admitted.updateCampaigns.every(
        (campaign) =>
          campaign.installSource === 'archive' &&
          campaign.previousVersion === '4.0.0-alpha.0' &&
          campaign.targetVersion === VERSION,
      ),
      true,
    );
  });
});

test('publication admission rejects an omitted Linux ARM64 CLI archive', () => {
  withFixture((value) => {
    fs.rmSync(value.support.cliPath);
    assert.throws(
      () => verify(value),
      /missing linux-arm64 archive kungfu-episodes-cli-linux-arm64\.tar\.gz/u,
    );
  });
});

test('publication admission rejects an omitted Linux ARM64 CLI qualification', () => {
  withFixture((value) => {
    fs.rmSync(value.support.cliQualificationPath);
    assert.throws(
      () => verify(value),
      /missing linux-arm64 qualification kungfu-episodes-cli-linux-arm64\.qualification\.json/u,
    );
  });
});

test('publication admission rejects tampered Linux ARM64 CLI bytes', () => {
  withFixture((value) => {
    fs.appendFileSync(value.support.cliPath, 'tampered');
    assert.throws(() => verify(value), /archive SHA256 mismatch/u);
  });
});

test('publication admission rejects a Linux ARM64 CLI source mismatch', () => {
  withFixture((value) => {
    rewriteCliQualification(value.support.cliQualificationPath, (report) => {
      report.identity.sourceCommit = 'f'.repeat(40);
    });
    assert.throws(
      () => verify(value),
      /linux-arm64 CLI qualification identity is not bound to the release candidate/u,
    );
  });
});

test('publication admission keeps exact installer bytes while omitting unadvertised upgrade qualification claims', () => {
  withFixture((value) => {
    for (const platform of Object.values(value.platforms)) {
      fs.rmSync(platform.evidencePath);
    }
    writeJson(
      path.join(
        value.platforms.darwin.bundleRoot,
        '.buildchain',
        'signing',
        'credential-island-evidence.json',
      ),
      { retainedCopy: true },
    );
    const manifestOnlyRoot = path.join(
      value.payloadRoot,
      'kungfu-credential-manifest-macos',
    );
    fs.mkdirSync(manifestOnlyRoot, { recursive: true });
    fs.copyFileSync(
      value.credential.manifestPath,
      path.join(manifestOnlyRoot, 'manifest.json'),
    );
    const admitted = verifyUpgradePublicationPayloads({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      qualificationPlatforms: [],
    });
    assert.deepEqual(admitted.platforms, [
      'darwin-arm64',
      'linux-x64',
      'win32-x64',
    ]);
    assert.deepEqual(admitted.evidenceRefs, []);
    assert.deepEqual(admitted.campaignRoots, []);
    assert.equal(
      admitted.credentialIsland.platformId,
      'macos-arm64-credential',
    );
  });
});

test('candidate finalization honors explicit unadvertised upgrade qualification claims', () => {
  withFixture((value) => {
    for (const platform of Object.values(value.platforms)) {
      fs.rmSync(platform.evidencePath);
    }
    writeJson(
      path.join(
        value.platforms.darwin.bundleRoot,
        '.buildchain',
        'signing',
        'credential-island-evidence.json',
      ),
      { retainedCopy: true },
    );
    const manifestOnlyRoot = path.join(
      value.payloadRoot,
      'kungfu-credential-manifest-macos',
    );
    fs.mkdirSync(manifestOnlyRoot, { recursive: true });
    fs.copyFileSync(
      value.credential.manifestPath,
      path.join(manifestOnlyRoot, 'manifest.json'),
    );
    const outputRoot = path.join(
      value.payloadRoot,
      `kungfu-product-admission-${SOURCE}`,
    );
    const written = writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
      ),
      capsulePath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
      ),
    });
    assert.deepEqual(written.receipt.admission.evidenceRefs, []);
    assert.deepEqual(written.receipt.admission.campaignRoots, []);
    assert.deepEqual(written.receipt.admission.updateCampaigns, []);
  });
});

test('publication admission still requires evidence for every advertised upgrade platform', () => {
  withFixture((value) => {
    fs.rmSync(value.platforms.linux.evidencePath);
    assert.throws(
      () =>
        verifyUpgradePublicationPayloads({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: VERSION,
          qualificationPlatforms: ['linux'],
        }),
      /must contain exactly one/u,
    );
  });
});

test('publication admission rejects a missing credential-island payload', () => {
  withFixture((value) => {
    fs.rmSync(value.credential.bundleRoot, {
      recursive: true,
      force: true,
    });
    assert.throws(
      () => verify(value),
      /exactly one authoritative macOS credential-island payload; found 0/,
    );
  });
});

test('publication admission rejects signed DMG byte drift', () => {
  withFixture((value) => {
    fs.appendFileSync(value.credential.dmgPath, 'drift');
    assert.throws(() => verify(value), /credential manifest size mismatch/);
  });
});

test('publication admission rejects a non-authoritative signing identity', () => {
  withFixture((value) => {
    const evidence = JSON.parse(
      fs.readFileSync(value.credential.evidencePath, 'utf8'),
    );
    evidence.identity.certificateSha1 = 'f'.repeat(40);
    writeJson(value.credential.evidencePath, evidence);
    credentialManifest(
      value.root,
      value.credential.bundleRoot,
      value.credential.evidencePath,
      value.credential.dmgPath,
      value.credential.zipPath,
    );
    assert.throws(
      () => verify(value),
      /credential-island signing identity is invalid/,
    );
  });
});

test('publication admission rejects unaccepted notarization evidence', () => {
  withFixture((value) => {
    const evidence = JSON.parse(
      fs.readFileSync(value.credential.evidencePath, 'utf8'),
    );
    evidence.notarization.diskImage.status = 'Invalid';
    writeJson(value.credential.evidencePath, evidence);
    credentialManifest(
      value.root,
      value.credential.bundleRoot,
      value.credential.evidencePath,
      value.credential.dmgPath,
      value.credential.zipPath,
    );
    assert.throws(
      () => verify(value),
      /diskImage notarization was not accepted/,
    );
  });
});

test('publication admission rejects missing retained qualification evidence', () => {
  withFixture((value) => {
    fs.rmSync(value.platforms.linux.evidencePath);
    assert.throws(() => verify(value), /must contain exactly one/);
  });
});

test('publication admission rejects payload byte drift after manifest creation', () => {
  withFixture((value) => {
    fs.appendFileSync(value.platforms.win32.cliPath, 'drift');
    assert.throws(
      () => verify(value),
      /(?:artifact size mismatch|archive SHA256 mismatch)/u,
    );
  });
});

test('publication admission rejects source identity outside the RC passport', () => {
  withFixture((value) => {
    for (const manifestPath of [
      value.platforms.darwin.desktopManifestPath,
      value.platforms.darwin.cliManifestPath,
    ]) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.sourceCommit = 'c'.repeat(40);
      writeJson(manifestPath, manifest);
    }
    assert.throws(() => verify(value), /not bound by the release-candidate/);
  });
});

test('publication admission rejects campaign evidence bound to a different RC passport', () => {
  withFixture((value) => {
    const passport = JSON.parse(fs.readFileSync(value.passportPath, 'utf8'));
    passport.unrelatedRetainedField = true;
    writeJson(value.passportPath, passport);
    assert.throws(
      () => verify(value),
      /campaign release-passport root does not match Buildchain/,
    );
  });
});

test('publication admission rejects an incomplete platform matrix', () => {
  withFixture((value) => {
    fs.rmSync(value.platforms.linux.bundleRoot, {
      recursive: true,
      force: true,
    });
    assert.throws(
      () => verify(value),
      /CLI publication requires exactly one linux-x64 payload bundle; found 0/,
    );
  });
});

test('publication admission rejects divergent duplicate release manifests', () => {
  withFixture((value) => {
    const manifest = JSON.parse(
      fs.readFileSync(value.platforms.darwin.cliManifestPath, 'utf8'),
    );
    manifest.releaseChannel = 'release';
    writeJson(value.platforms.darwin.cliManifestPath, manifest);
    assert.throws(() => verify(value), /divergent copies/);
  });
});

test('candidate finalization seals one rooted product admission receipt into its capsule', () => {
  withFixture((value) => {
    const outputRoot = path.join(
      value.payloadRoot,
      `kungfu-product-admission-${SOURCE}`,
    );
    const outputPath = path.join(
      outputRoot,
      PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
    );
    const capsulePath = path.join(
      outputRoot,
      PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
    );
    const written = writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath,
      capsulePath,
    });
    assert.equal(
      written.receipt.schema,
      PRODUCT_UPGRADE_PUBLICATION_ADMISSION_SCHEMA,
    );
    assert.equal(
      written.capsule.schema,
      PRODUCT_UPGRADE_PUBLICATION_CAPSULE_SCHEMA,
    );
    assert.equal(
      written.capsule.admission.receiptRoot,
      written.receipt.receiptRoot,
    );
    assert.equal(written.receipt.claims.externalPublication, false);
    assert.equal(written.receipt.admission.cliArtifacts.length, 4);
    assert.equal(written.receipt.candidate.bundleCount, 5);
    assert.deepEqual(
      written.receipt.candidate.bundles.map(({ role }) => role).sort(),
      [
        'credential-island',
        'product-support',
        'product-upgrade',
        'product-upgrade',
        'product-upgrade',
      ],
    );
    const verified = verifyUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      expectedSourceSha: SOURCE,
    });
    assert.equal(verified.receiptRoot, written.receipt.receiptRoot);
    assert.equal(verified.capsuleRoot, written.capsule.capsuleRoot);
    assert.equal(verified.manifests.length, 3);
  });
});

test('sealed admission rehydrates finalized Darwin CLI bytes for publication', () => {
  withFixture((value) => {
    const finalBytes = finalizeDarwinCliFixture(value);
    const outputRoot = path.join(value.payloadRoot, 'kungfu-product-admission');
    writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
      ),
      capsulePath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
      ),
    });
    const verified = verifyUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      expectedSourceSha: SOURCE,
    });
    const darwin = verified.manifests.find(
      ({ platform }) => platform === 'darwin',
    );
    const cli = darwin.manifest.artifacts.find(({ kind }) => kind === 'cli');
    assert.equal(cli.size, finalBytes.length);
    assert.equal(cli.digest, `sha256:${sha256(finalBytes)}`);
    assert.match(cli.signature, /provider-evidence\.json/u);
  });
});

test('sealed product admission accepts a same-tree recovery promotion source', () => {
  withFixture((value) => {
    const promotedSource = 'c'.repeat(40);
    const sourceTree = 'd'.repeat(40);
    const outputRoot = path.join(value.payloadRoot, 'kungfu-product-admission');
    writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
      ),
      capsulePath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
      ),
    });
    const recoveryReceiptPath = path.join(
      value.payloadRoot,
      'recovery-receipt.json',
    );
    const recovery = {
      schemaVersion: 1,
      contract: 'kungfu-buildchain-release-candidate-recovery/v1',
      action: 'reused',
      originalCandidate: { sourceSha: SOURCE, tree: sourceTree },
      target: { sha: promotedSource, tree: sourceTree, version: VERSION },
      recovered: { candidateRoot: `sha256:${'e'.repeat(64)}` },
      skippedBuildStages: ['install', 'build', 'verify', 'platform-matrix'],
      payloadBytes: 'unchanged',
    };
    recovery.root = contentRoot(recovery);
    writeJson(recoveryReceiptPath, recovery);

    const verified = verifyUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      expectedSourceSha: promotedSource,
      recoveryReceiptPath,
    });
    assert.equal(verified.receiptRoot.startsWith('sha256:'), true);

    const receiptPath = path.join(
      outputRoot,
      PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
    );
    const capsulePath = path.join(
      outputRoot,
      PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
    );
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.roots.tooling = `sha256:${'1'.repeat(64)}`;
    Reflect.deleteProperty(receipt, 'receiptRoot');
    receipt.receiptRoot = contentRoot(receipt);
    writeJson(receiptPath, receipt);
    const capsule = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));
    capsule.admission.receiptRoot = receipt.receiptRoot;
    capsule.admission.fileRoot = `sha256:${sha256(fs.readFileSync(receiptPath))}`;
    Reflect.deleteProperty(capsule, 'capsuleRoot');
    capsule.capsuleRoot = contentRoot(capsule);
    writeJson(capsulePath, capsule);

    assert.throws(
      () =>
        verifyUpgradePublicationAdmission({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: VERSION,
          expectedSourceSha: promotedSource,
          recoveryReceiptPath,
        }),
      /product admission tooling root drift/,
    );

    const controllerSha = '2'.repeat(40);
    const gateAggregate = {
      contract: 'buildchain.shifu-gate-aggregate/v1',
      profile: 'release-promotion',
      sourceSha: promotedSource,
      status: 'pass',
      ok: true,
      qualifying: true,
      candidateReuse: { action: 'reused', sourceTreeSha: sourceTree },
      consumerGateController: {
        repository: 'kungfu-systems/kungfu',
        sha: controllerSha,
        commandDigest: `sha256:${'3'.repeat(64)}`,
      },
    };
    gateAggregate.digest = contentRoot(gateAggregate);
    const repaired = verifyUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      expectedSourceSha: promotedSource,
      recoveryReceiptPath,
      publicationGateAggregateJson: JSON.stringify(gateAggregate),
      expectedControllerRepository: 'kungfu-systems/kungfu',
      expectedControllerSha: controllerSha,
    });
    assert.equal(repaired.receiptRoot, receipt.receiptRoot);

    assert.throws(
      () =>
        verifyUpgradePublicationAdmission({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: VERSION,
          expectedSourceSha: promotedSource,
          recoveryReceiptPath,
          publicationGateAggregateJson: JSON.stringify(gateAggregate),
          expectedControllerRepository: 'kungfu-systems/kungfu',
          expectedControllerSha: '4'.repeat(40),
        }),
      /does not bind the recovery controller/,
    );

    recovery.target.tree = 'f'.repeat(40);
    Reflect.deleteProperty(recovery, 'root');
    recovery.root = contentRoot(recovery);
    writeJson(recoveryReceiptPath, recovery);
    assert.throws(
      () =>
        verifyUpgradePublicationAdmission({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: VERSION,
          expectedSourceSha: promotedSource,
          recoveryReceiptPath,
        }),
      /does not bind the promotion source/,
    );
  });
});

test('candidate finalization ignores root-manifest-only artifact projections', () => {
  withFixture((value) => {
    for (const [name, manifestPath] of [
      ['kungfu-credential-manifest-macos', value.credential.manifestPath],
      [
        'kungfu-manifest-linux-arm64',
        path.join(value.support.bundleRoot, 'manifest.json'),
      ],
      [
        'kungfu-manifest-linux-x64',
        path.join(value.platforms.linux.bundleRoot, 'manifest.json'),
      ],
    ]) {
      const projectionRoot = path.join(value.payloadRoot, name);
      fs.mkdirSync(projectionRoot, { recursive: true });
      fs.copyFileSync(manifestPath, path.join(projectionRoot, 'manifest.json'));
    }
    const outputRoot = path.join(
      value.payloadRoot,
      `kungfu-product-admission-${SOURCE}`,
    );
    const written = writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
      ),
      capsulePath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
      ),
    });
    assert.equal(written.receipt.candidate.bundleCount, 5);
    assert.deepEqual(
      written.receipt.candidate.bundles.map(({ name }) => name).sort(),
      [
        path.basename(value.credential.bundleRoot),
        path.basename(value.platforms.darwin.bundleRoot),
        path.basename(value.platforms.linux.bundleRoot),
        path.basename(value.platforms.win32.bundleRoot),
        path.basename(value.support.bundleRoot),
      ].sort(),
    );
  });
});

test('candidate finalization retains Linux ARM64 as product support when it carries an upgrade manifest', () => {
  withFixture((value) => {
    const supportManifestPath = path.join(
      value.support.bundleRoot,
      'product',
      'release',
      'cli',
      `kungfu-upgrade-${VERSION}-linux-arm64.json`,
    );
    const supportManifest = JSON.parse(
      fs.readFileSync(value.platforms.linux.cliManifestPath, 'utf8'),
    );
    supportManifest.platform = 'linux';
    supportManifest.architecture = 'arm64';
    writeJson(supportManifestPath, supportManifest);
    const outputRoot = path.join(
      value.payloadRoot,
      `kungfu-product-admission-${SOURCE}`,
    );
    const written = writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
      ),
      capsulePath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
      ),
    });
    assert.equal(written.receipt.candidate.bundleCount, 5);
    assert.deepEqual(
      written.receipt.candidate.bundles
        .filter(({ platformId }) => platformId === 'linux-arm64')
        .map(({ role }) => role),
      ['product-support'],
    );
    assert.deepEqual(written.receipt.admission.platforms, [
      'darwin-arm64',
      'linux-x64',
      'win32-x64',
    ]);
  });
});

test('candidate finalization treats a real Linux ARM64 upgrade manifest without a root projection as support-only', () => {
  withFixture((value) => {
    fs.rmSync(path.join(value.support.bundleRoot, 'manifest.json'));
    const supportManifestPath = path.join(
      value.support.bundleRoot,
      'product',
      'release',
      'cli',
      `kungfu-upgrade-${VERSION}-linux-arm64.json`,
    );
    const supportManifest = JSON.parse(
      fs.readFileSync(value.platforms.linux.cliManifestPath, 'utf8'),
    );
    supportManifest.platform = 'linux';
    supportManifest.architecture = 'arm64';
    writeJson(supportManifestPath, supportManifest);
    const outputRoot = path.join(
      value.payloadRoot,
      `kungfu-product-admission-${SOURCE}`,
    );
    const written = writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
      ),
      capsulePath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
      ),
    });
    assert.equal(written.receipt.candidate.bundleCount, 5);
    assert.equal(
      written.receipt.candidate.bundles.find(
        ({ role }) => role === 'product-support',
      ).platformId,
      'linux-arm64',
    );
  });
});

test('candidate finalization rejects a candidate without the exact five bundle roles', () => {
  withFixture((value) => {
    fs.rmSync(value.support.bundleRoot, { recursive: true });
    assert.throws(
      () =>
        writeUpgradePublicationAdmission({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: VERSION,
          outputPath: path.join(
            value.payloadRoot,
            'kungfu-product-admission',
            PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
          ),
        }),
      /requires exactly 1 product-support bundle; found 0/,
    );
  });
  withFixture((value) => {
    const manifestPath = path.join(value.support.bundleRoot, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.platform.id = 'linux-x64';
    writeJson(manifestPath, manifest);
    assert.throws(
      () =>
        writeUpgradePublicationAdmission({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: VERSION,
          outputPath: path.join(
            value.payloadRoot,
            'kungfu-product-admission',
            PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
          ),
        }),
      /product-support platform roles must be linux-arm64; found linux-x64/,
    );
  });
});

test('sealed product admission rejects candidate bytes changed after finalization', () => {
  withFixture((value) => {
    const outputRoot = path.join(value.payloadRoot, 'kungfu-product-admission');
    writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
      ),
      capsulePath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
      ),
    });
    fs.appendFileSync(value.platforms.linux.cliPath, 'post-seal-drift');
    assert.throws(
      () =>
        verifyUpgradePublicationAdmission({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: VERSION,
        }),
      /product admission artifact root drift/,
    );
  });
});

test('sealed product admission rejects passport drift and a stale version', () => {
  withFixture((value) => {
    const outputRoot = path.join(value.payloadRoot, 'kungfu-product-admission');
    writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
      ),
      capsulePath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
      ),
    });
    assert.throws(
      () =>
        verifyUpgradePublicationAdmission({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: '4.0.0-alpha.2',
        }),
      /product admission version is stale/,
    );
    fs.appendFileSync(value.passportPath, ' ');
    assert.throws(
      () =>
        verifyUpgradePublicationAdmission({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: VERSION,
        }),
      /product admission passport root drift/,
    );
  });
});

test('sealed product admission rejects receipt tampering', () => {
  withFixture((value) => {
    const outputRoot = path.join(value.payloadRoot, 'kungfu-product-admission');
    const outputPath = path.join(
      outputRoot,
      PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
    );
    writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath,
      capsulePath: path.join(
        outputRoot,
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
      ),
    });
    const receipt = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    receipt.admission.platforms = ['linux-x64'];
    writeJson(outputPath, receipt);
    assert.throws(
      () =>
        verifyUpgradePublicationAdmission({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: VERSION,
        }),
      /product admission receipt root drift/,
    );
  });
});

test('sealed product admission rejects semantically forged campaign roots after resealing', () => {
  withFixture((value) => {
    const outputRoot = path.join(value.payloadRoot, 'kungfu-product-admission');
    const outputPath = path.join(
      outputRoot,
      PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
    );
    const capsulePath = path.join(
      outputRoot,
      PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
    );
    writeUpgradePublicationAdmission({
      payloadRoot: value.payloadRoot,
      releaseCandidatePassportPath: value.passportPath,
      expectedVersion: VERSION,
      outputPath,
      capsulePath,
    });
    const receipt = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    receipt.admission.updateCampaigns = [{ targetVersion: '4.0.0-forged' }];
    receipt.roots.campaign = contentRoot(receipt.admission.updateCampaigns);
    const { receiptRoot: _oldReceiptRoot, ...receiptBody } = receipt;
    receipt.receiptRoot = contentRoot(receiptBody);
    writeJson(outputPath, receipt);
    const capsule = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));
    capsule.admission.receiptRoot = receipt.receiptRoot;
    capsule.admission.fileRoot = `sha256:${sha256(fs.readFileSync(outputPath))}`;
    const { capsuleRoot: _oldCapsuleRoot, ...capsuleBody } = capsule;
    capsule.capsuleRoot = contentRoot(capsuleBody);
    writeJson(capsulePath, capsule);
    assert.throws(
      () =>
        verifyUpgradePublicationAdmission({
          payloadRoot: value.payloadRoot,
          releaseCandidatePassportPath: value.passportPath,
          expectedVersion: VERSION,
        }),
      /product admission campaign projection drift/,
    );
  });
});
