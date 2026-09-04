// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readElectronBuilderProjection } from '../../developer/maintainability/semantic-amplification.mjs';
import {
  artifactSignatureStatement,
  loadUpgradeQualificationContract,
  qualificationContentRoot,
  updateCampaignRoot,
} from '../../scripts/upgrade-qualification.mjs';
import {
  UNQUALIFIED_RELEASE_EVIDENCE,
  assertUpgradeIdentityConverged,
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
  const campaign = {
    schema: contract.campaignSchema,
    generatedAt: new Date().toISOString(),
    evidenceTier: contract.promotionTier,
    cleanEnvironment: true,
    publicClaim: { advertised: true, mechanicsOnly: false },
    channel: manifest.releaseChannel,
    platform: manifest.platform,
    architecture: manifest.architecture,
    installSource: 'archive',
    installOwner: contract.installSources.archive.owner,
    action: contract.installSources.archive.action,
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
      releasePassportRoot: `sha256:${'8'.repeat(64)}`,
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
        contract.requiredSmokeChecks.map((name) => [name, true]),
      ),
    },
    activation: {
      activeWorkContinues: true,
      existingWorkRuntime: 'previous-pinned',
      newWorkActivation: 'fenced-safe-point-or-next-command',
      supervisorActionRequired: false,
    },
    faults: contract.requiredFaults.map((id, index) => ({
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
    documentationPaths: [...contract.documentation.requiredPaths],
  };
  campaign.campaignRoot = updateCampaignRoot(campaign);
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
    fs.mkdirSync(path.join(f.runtimeRoot, '__pycache__'));
    fs.writeFileSync(
      path.join(f.runtimeRoot, '__pycache__', 'runtime.pyc'),
      'bytecode',
    );
    const bytecodeChanged = buildBundledUpgradeManifest({
      ...f,
      platform: 'darwin',
      architecture: 'arm64',
      revision: '1'.repeat(40),
    });
    assert.equal(bytecodeChanged.runtimeBuildId, manifest.runtimeBuildId);
    assert.equal(bytecodeChanged.frontendBuildId, manifest.frontendBuildId);
    fs.writeFileSync(path.join(f.runtimeRoot, 'kungfu'), 'changed');
    const changed = buildBundledUpgradeManifest({
      ...f,
      platform: 'darwin',
      architecture: 'arm64',
      revision: '1'.repeat(40),
    });
    assert.notEqual(changed.runtimeBuildId, manifest.runtimeBuildId);
    assert.notEqual(changed.frontendBuildId, manifest.frontendBuildId);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('Buildchain source-build evidence remains publication-ineligible', () => {
  const f = fixture();
  try {
    const evidence =
      'buildchain-retained:product/release/qualification/kungfu-upgrade-qualification-evidence.json';
    const options = {
      ...f,
      platform: 'win32',
      architecture: 'x64',
      revision: '1'.repeat(40),
      runtimeSignature: `${evidence}#runtime`,
      qualificationEvidenceRef: evidence,
    };
    const sourceBuild = buildBundledUpgradeManifest({
      ...options,
      sourceBuild: true,
    });
    assert.deepEqual(sourceBuild.releaseCut.publicationPolicy, {
      trustDomain: 'shifu-local',
      publicationEligible: false,
      immutable: true,
      eligibleChannels: [],
    });

    const publicBuild = buildBundledUpgradeManifest({
      ...options,
      sourceBuild: false,
    });
    assert.equal(
      publicBuild.releaseCut.publicationPolicy.trustDomain,
      'public',
    );
    assert.equal(
      publicBuild.releaseCut.publicationPolicy.publicationEligible,
      true,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('combined release rejects a CLI and desktop identity split', () => {
  const root = `sha256:${'1'.repeat(64)}`;
  assert.doesNotThrow(() =>
    assertUpgradeIdentityConverged(
      { manifestIdentityRoot: root },
      { manifestIdentityRoot: root },
    ),
  );
  assert.throws(
    () =>
      assertUpgradeIdentityConverged(
        { manifestIdentityRoot: root },
        { manifestIdentityRoot: `sha256:${'2'.repeat(64)}` },
      ),
    /divergent upgrade identities/u,
  );
});

test('Product Release Cut roots verify identically in Node and Python', () => {
  const f = fixture();
  try {
    const manifest = buildBundledUpgradeManifest({
      ...f,
      platform: 'linux',
      architecture: 'x64',
      revision: '1'.repeat(40),
    });
    const modulePath = path.join(repoRoot, 'framework/core/src/python');
    const script = `
import json, sys
sys.path.insert(0, sys.argv[1])
from kungfu import runtime_upgrade as module
manifest = json.load(sys.stdin)
cut = module.validate_release_cut(manifest["releaseCut"])
print(json.dumps({
  "manifestIdentityRoot": module.manifest_identity_root(manifest),
  "releaseCutRoot": cut["releaseCutRoot"],
  "platformSliceRoot": cut["platformSlices"][0]["platformSliceRoot"],
}, sort_keys=True))
`;
    const python = spawnSync(
      process.env.PYTHON ||
        (process.platform === 'win32' ? 'python' : 'python3'),
      ['-c', script, modulePath],
      {
        cwd: repoRoot,
        input: JSON.stringify(manifest),
        encoding: 'utf8',
      },
    );
    assert.equal(python.status, 0, python.stderr);
    assert.deepEqual(JSON.parse(python.stdout), {
      manifestIdentityRoot: manifest.manifestIdentityRoot,
      platformSliceRoot: manifest.platformSliceRoot,
      releaseCutRoot: manifest.releaseCutRoot,
    });
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
    assert.deepEqual(release.localArtifact, {
      kind: 'desktop-local',
      format: 'file',
      size: 9,
      digest: release.artifacts.at(-1).digest,
    });
    assert.equal(
      release.manifestIdentityRoot,
      bundledManifest.manifestIdentityRoot,
    );
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

test('desktop local tree bytes are part of the exact Release Cut', () => {
  const f = fixture();
  try {
    const bundledManifest = buildBundledUpgradeManifest({
      ...f,
      platform: 'darwin',
      architecture: 'arm64',
      revision: '4'.repeat(40),
    });
    const updater = path.join(f.root, 'Kungfu Episodes.zip');
    const app = path.join(f.root, 'Kungfu Episodes.app');
    fs.writeFileSync(updater, 'desktop-updater');
    fs.mkdirSync(path.join(app, 'Contents'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'product.bin'), 'first');
    const first = finalizeDesktopUpgradeManifest({
      bundledManifest,
      desktopArtifact: updater,
      localArtifact: app,
      artifactUrl: 'https://example.invalid/Kungfu-Episodes.zip',
      output: path.join(f.root, 'first.json'),
    });
    fs.writeFileSync(path.join(app, 'Contents', 'product.bin'), 'second');
    const second = finalizeDesktopUpgradeManifest({
      bundledManifest,
      desktopArtifact: updater,
      localArtifact: app,
      artifactUrl: 'https://example.invalid/Kungfu-Episodes.zip',
      output: path.join(f.root, 'second.json'),
    });
    assert.equal(first.localArtifact.format, 'directory');
    assert.notEqual(first.localArtifact.digest, second.localArtifact.digest);
    assert.equal(
      first.manifestIdentityRoot,
      bundledManifest.manifestIdentityRoot,
    );
    assert.equal(
      second.manifestIdentityRoot,
      bundledManifest.manifestIdentityRoot,
    );
    assert.notEqual(first.releaseCutRoot, second.releaseCutRoot);
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
      embeddedManifest: bundledManifest,
      cliArtifact: archive,
      artifactUrl: 'https://example.invalid/kungfu-cli.tar.gz',
      output,
    });
    assert.equal(
      release.manifestIdentityRoot,
      bundledManifest.manifestIdentityRoot,
    );
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
    const config = readElectronBuilderProjection(path.join(repoRoot, relative));
    assert.ok(
      config.extraResources.some(
        (resource) =>
          resource.from === 'dist/update/kungfu-release-manifest.json' &&
          resource.to === 'upgrade/kungfu-release-manifest.json',
      ),
    );
    assert.equal(config.generateUpdatesFilesForAllChannels, true);
    assert.equal(config.publish[0].channel, 'alpha');
  }
});
