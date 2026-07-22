// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  artifactSignatureStatement,
  loadUpgradeQualificationContract,
} from '../../scripts/upgrade-qualification.mjs';
import {
  UNQUALIFIED_RELEASE_EVIDENCE,
  assertUpgradePublicationEligible,
  buildBundledUpgradeManifest,
  finalizeCliUpgradeManifest,
  finalizeDesktopUpgradeManifest,
  platformUpgradeManifestName,
} from './upgrade-manifest.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-upgrade-release-'),
  );
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(root, 'product'), { recursive: true });
  fs.mkdirSync(runtimeRoot);
  fs.writeFileSync(
    path.join(root, 'product', 'package.json'),
    JSON.stringify({ version: '4.0.0-alpha.1' }),
  );
  fs.writeFileSync(path.join(runtimeRoot, 'kungfu'), 'runtime');
  return { root, runtimeRoot };
}

function qualificationEvidence(manifest) {
  const contract = loadUpgradeQualificationContract();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  return {
    schema: contract.evidenceSchema,
    evidenceRef: manifest.qualificationEvidenceRef,
    sourceCommit: manifest.sourceCommit,
    productVersion: manifest.productVersion,
    platform: manifest.platform,
    architecture: manifest.architecture,
    tier: contract.promotionTier,
    surfaces: manifest.artifacts.map((artifact) => artifact.kind),
    runtimeChurnIterations: contract.minimumRuntimeChurnIterations,
    checks: Object.fromEntries(
      contract.requiredChecks.map((name) => [name, true]),
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

test('bundled manifest binds exact runtime bytes and source product identity', () => {
  const f = fixture();
  try {
    const manifest = buildBundledUpgradeManifest({
      ...f,
      platform: 'darwin',
      architecture: 'arm64',
      revision: '1'.repeat(40),
    });
    assert.match(manifest.runtimeArtifactDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(manifest.runtimeBuildId, /^runtime-4\.0\.0-alpha\.1-/);
    assert.match(manifest.frontendBuildId, /^product-4\.0\.0-alpha\.1-/);
    assert.equal(manifest.runtimeEntrypoint, 'kungfu');
    assert.equal(manifest.artifacts[0].signature, UNQUALIFIED_RELEASE_EVIDENCE);
    fs.writeFileSync(path.join(f.runtimeRoot, 'kungfu'), 'changed');
    const changed = buildBundledUpgradeManifest({
      ...f,
      platform: 'darwin',
      architecture: 'arm64',
      revision: '1'.repeat(40),
    });
    assert.notEqual(changed.runtimeBuildId, manifest.runtimeBuildId);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('bundled manifest binds internal symlinks and rejects tree escape', () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.runtimeRoot, 'python3'), 'interpreter');
    fs.symlinkSync('python3', path.join(f.runtimeRoot, 'python'));
    const manifest = buildBundledUpgradeManifest({
      ...f,
      platform: 'darwin',
      architecture: 'arm64',
      revision: '1'.repeat(40),
    });
    assert.equal(manifest.artifacts[0].size, 25);

    fs.rmSync(path.join(f.runtimeRoot, 'python'));
    fs.symlinkSync(
      '../product/package.json',
      path.join(f.runtimeRoot, 'python'),
    );
    assert.throws(
      () =>
        buildBundledUpgradeManifest({
          ...f,
          platform: 'darwin',
          architecture: 'arm64',
          revision: '1'.repeat(40),
        }),
      /escaping symlink/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('desktop finalization binds installer bytes and stays fail-closed locally', () => {
  const f = fixture();
  try {
    const bundledManifest = buildBundledUpgradeManifest({
      ...f,
      platform: 'win32',
      architecture: 'x64',
      revision: '2'.repeat(40),
    });
    const artifact = path.join(f.root, 'Kungfu Episodes Setup.exe');
    const output = path.join(f.root, 'release', 'manifest.json');
    fs.writeFileSync(artifact, 'installer');
    const release = finalizeDesktopUpgradeManifest({
      bundledManifest,
      desktopArtifact: artifact,
      artifactUrl: 'https://example.invalid/Kungfu-Episodes-Setup.exe',
      output,
    });
    assert.equal(release.artifacts.at(-1).size, 9);
    assert.match(release.artifacts.at(-1).digest, /^sha256:[a-f0-9]{64}$/);
    assert.throws(
      () => assertUpgradePublicationEligible(release),
      /qualification evidence/,
    );
    const eligible = structuredClone(release);
    eligible.qualificationEvidenceRef = 'buildchain:qualification/run-1';
    for (const artifactRow of eligible.artifacts) {
      artifactRow.signature = `sigstore:bundle:${artifactRow.digest}`;
    }
    assert.throws(
      () => assertUpgradePublicationEligible(eligible),
      /qualification evidence is required/,
    );
    assert.equal(
      assertUpgradePublicationEligible(
        eligible,
        'desktop',
        qualificationEvidence(eligible),
      ),
      eligible,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('external manifest asset names are deterministic and platform-specific', () => {
  assert.equal(
    platformUpgradeManifestName('4.0.0-alpha.1', 'linux', 'x64'),
    'kungfu-upgrade-4.0.0-alpha.1-linux-x64.json',
  );
});

test('CLI finalization adds an exact archive without losing desktop evidence', () => {
  const f = fixture();
  try {
    const bundledManifest = buildBundledUpgradeManifest({
      ...f,
      platform: 'linux',
      architecture: 'x64',
      revision: '3'.repeat(40),
    });
    const installer = path.join(f.root, 'kungfu-desktop.AppImage');
    fs.writeFileSync(installer, 'desktop-installer');
    const desktopManifest = finalizeDesktopUpgradeManifest({
      bundledManifest,
      desktopArtifact: installer,
      artifactUrl: 'https://example.invalid/kungfu-desktop.AppImage',
      output: path.join(f.root, 'release', 'desktop-manifest.json'),
    });
    const archive = path.join(f.root, 'kungfu-cli.tar.gz');
    fs.writeFileSync(archive, 'cli-archive');
    const output = path.join(f.root, 'release', 'manifest.json');
    const release = finalizeCliUpgradeManifest({
      bundledManifest: desktopManifest,
      cliArtifact: archive,
      artifactUrl: 'https://example.invalid/kungfu-cli.tar.gz',
      output,
    });
    assert.deepEqual(
      release.artifacts.map((artifact) => artifact.kind),
      ['runtime', 'desktop', 'cli'],
    );
    const eligible = structuredClone(release);
    eligible.qualificationEvidenceRef = 'buildchain:qualification/run-cli';
    for (const artifact of eligible.artifacts) {
      artifact.signature = `sigstore:bundle:${artifact.digest}`;
    }
    assert.equal(
      assertUpgradePublicationEligible(
        eligible,
        'cli',
        qualificationEvidence(eligible),
      ),
      eligible,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('both desktop builders retain the bundled upgrade identity outside runtime', () => {
  for (const relative of [
    'framework/gui/electron-builder.yml',
    'product/electron-builder.yml',
  ]) {
    const config = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    assert.match(
      config,
      /dist\/update\/kungfu-release-manifest\.json\n\s+to: upgrade\/kungfu-release-manifest\.json/,
    );
    assert.match(config, /generateUpdatesFilesForAllChannels: true/);
    assert.match(config, /channel: alpha/);
  }
});
