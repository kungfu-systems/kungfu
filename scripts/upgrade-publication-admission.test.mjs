// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyUpgradePublicationPayloads } from './upgrade-publication-admission.mjs';
import {
  artifactSignatureStatement,
  loadUpgradeQualificationContract,
} from './upgrade-qualification.mjs';

const VERSION = '4.0.0-alpha.1';
const SOURCE = 'a'.repeat(40);
const RUNTIME = 'd'.repeat(40);
const CERTIFICATE_SHA1 = '31c5f3444a2b04870a9fcc78bafc49954cc55862';
const CONTRACT = loadUpgradeQualificationContract();

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function signedEvidence(manifest) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
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
      ? `kungfu-cli-${platform}.zip`
      : `kungfu-cli-${platform}.tar.gz`;
  const desktopBytes = Buffer.from(`desktop-${platform}`);
  const cliBytes = Buffer.from(`cli-${platform}`);
  const desktopPath = path.join(releaseRoot, 'desktop', desktopName);
  const cliPath = path.join(releaseRoot, 'cli', cliName);
  fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
  fs.mkdirSync(path.dirname(cliPath), { recursive: true });
  fs.writeFileSync(desktopPath, desktopBytes);
  fs.writeFileSync(cliPath, cliBytes);
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
  return {
    bundleRoot,
    desktopPath,
    cliPath,
    desktopManifestPath,
    cliManifestPath,
    evidencePath,
  };
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
  const bundleRoot = path.join(root, 'payloads', 'kungfu-macos-credential');
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
        'Developer ID Application: Beijing Kungfu Technology Co., Ltd. (ZDL5TK5LL4)',
      teamId: 'ZDL5TK5LL4',
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

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-upgrade-publication-'),
  );
  const passportPath = path.join(
    root,
    'passport',
    'release-candidate-passport.json',
  );
  writeJson(passportPath, {
    contract: 'kungfu-buildchain-release-candidate-passport',
    source: { headSha: SOURCE, mergeRefSha: 'b'.repeat(40) },
  });
  const platforms = {
    darwin: platformFixture(root, 'darwin', 'arm64'),
    linux: platformFixture(root, 'linux', 'x64'),
    win32: platformFixture(root, 'win32', 'x64'),
  };
  const credential = credentialFixture(root);
  return {
    root,
    payloadRoot: path.join(root, 'payloads'),
    passportPath,
    platforms,
    credential,
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

test('publication admission verifies three native payloads plus authoritative signed macOS bytes', () => {
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
      admitted.credentialIsland.platformId,
      'macos-arm64-credential',
    );
    assert.equal(admitted.credentialIsland.runtimeSha, RUNTIME);
    assert.equal(admitted.credentialIsland.certificateSha1, CERTIFICATE_SHA1);
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
    assert.throws(() => verify(value), /artifact size mismatch/);
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

test('publication admission rejects an incomplete platform matrix', () => {
  withFixture((value) => {
    fs.rmSync(value.platforms.linux.bundleRoot, {
      recursive: true,
      force: true,
    });
    assert.throws(
      () => verify(value),
      /exactly one admitted linux payload; found 0/,
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
