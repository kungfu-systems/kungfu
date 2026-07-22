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
  return {
    root,
    payloadRoot: path.join(root, 'payloads'),
    passportPath,
    platforms,
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

test('publication admission verifies three native payloads and exact desktop/CLI bytes', () => {
  withFixture((value) => {
    assert.deepEqual(verify(value).platforms, [
      'darwin-arm64',
      'linux-x64',
      'win32-x64',
    ]);
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
