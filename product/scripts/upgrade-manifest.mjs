// SPDX-License-Identifier: Apache-2.0
// Build the release identity shared by the bundled runtime and the external
// desktop updater. Local packages remain explicitly unqualified; a remote
// update resolver must reject them until signing and qualification evidence is
// supplied by the release job.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadUpgradeQualificationContract,
  verifyUpgradeQualificationEvidence,
} from '../../scripts/upgrade-qualification.mjs';
import { internalSymlinkTarget, sha256Tree } from './compatibility.mjs';

export const UNQUALIFIED_RELEASE_EVIDENCE = 'unqualified-local-build';
const DOCUMENTATION_URL = 'https://www.kungfu.tech/docs/guides/upgrading';
const RELEASE_SCHEMA = 'kungfu.product-upgrade.manifest/v1';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sourceCommit(root) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error('cannot resolve source commit');
  return result.stdout.trim();
}

function treeSize(root) {
  let size = 0;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) size += fs.statSync(full).size;
      else if (entry.isSymbolicLink()) {
        size += Buffer.byteLength(internalSymlinkTarget(root, full));
      }
    }
  };
  visit(root);
  return size;
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function assertPlatform(platform, architecture) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) {
    throw new Error(`unsupported release platform: ${platform}`);
  }
  if (!['arm64', 'x64'].includes(architecture)) {
    throw new Error(`unsupported release architecture: ${architecture}`);
  }
}

function runtimeEntrypoint(platform) {
  return platform === 'win32' ? 'kungfu.exe' : 'kungfu';
}

export function platformUpgradeManifestName(version, platform, architecture) {
  return `kungfu-upgrade-${version}-${platform}-${architecture}.json`;
}

export function buildBundledUpgradeManifest({
  root,
  runtimeRoot,
  platform = process.platform,
  architecture = process.arch,
  releaseChannel = process.env.KF_RELEASE_CHANNEL || 'alpha',
  revision = sourceCommit(root),
  runtimeSignature = process.env.KF_RUNTIME_ARTIFACT_SIGNATURE ||
    UNQUALIFIED_RELEASE_EVIDENCE,
  qualificationEvidenceRef = process.env.KF_UPGRADE_QUALIFICATION_REF ||
    `${UNQUALIFIED_RELEASE_EVIDENCE}:${revision}`,
}) {
  assertPlatform(platform, architecture);
  if (!fs.statSync(runtimeRoot).isDirectory()) {
    throw new Error(`runtime root is not a directory: ${runtimeRoot}`);
  }
  const version = readJson(path.join(root, 'product', 'package.json')).version;
  const runtimeDigest = sha256Tree(runtimeRoot);
  const runtimeBuildId = `runtime-${version}-${runtimeDigest.slice(0, 16)}`;
  const frontendBuildId = `product-${version}-${revision.slice(0, 16)}`;
  return {
    schema: RELEASE_SCHEMA,
    productVersion: version,
    releaseChannel,
    sourceCommit: revision,
    runtimeBuildId,
    runtimeArtifactDigest: `sha256:${runtimeDigest}`,
    runtimeEntrypoint: runtimeEntrypoint(platform),
    frontendBuildId,
    controlProtocolRange: { min: 1, max: 1 },
    peerWireProtocolRange: { min: 1, max: 1 },
    journalSchemaReadRange: { min: 1, max: 1 },
    journalSchemaWriteVersion: 1,
    migrationClass: 'none',
    rollbackClass: 'automatic',
    minimumSupportedFrontend: version,
    minimumSupportedRuntime: version,
    platform,
    architecture,
    artifacts: [
      {
        kind: 'runtime',
        url: 'app-resource://kungfu',
        size: treeSize(runtimeRoot),
        digest: `sha256:${runtimeDigest}`,
        signature: runtimeSignature,
      },
    ],
    qualificationEvidenceRef,
    documentationUrl: DOCUMENTATION_URL,
  };
}

export function writeBundledUpgradeManifest(options) {
  const manifest = buildBundledUpgradeManifest(options);
  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(
    options.output,
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  return manifest;
}

export function finalizeDesktopUpgradeManifest({
  bundledManifest,
  desktopArtifact,
  artifactUrl,
  artifactSignature = process.env.KF_DESKTOP_ARTIFACT_SIGNATURE ||
    UNQUALIFIED_RELEASE_EVIDENCE,
  qualificationEvidenceRef = process.env.KF_UPGRADE_QUALIFICATION_REF ||
    bundledManifest.qualificationEvidenceRef,
  output,
}) {
  if (!fs.statSync(desktopArtifact).isFile()) {
    throw new Error(`desktop artifact is not a file: ${desktopArtifact}`);
  }
  const manifest = {
    ...bundledManifest,
    artifacts: [
      ...bundledManifest.artifacts.filter((item) => item.kind !== 'desktop'),
      {
        kind: 'desktop',
        url: artifactUrl,
        size: fs.statSync(desktopArtifact).size,
        digest: `sha256:${sha256File(desktopArtifact)}`,
        signature: artifactSignature,
      },
    ],
    qualificationEvidenceRef,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function finalizeCliUpgradeManifest({
  bundledManifest,
  cliArtifact,
  artifactUrl,
  artifactSignature = process.env.KF_CLI_ARTIFACT_SIGNATURE ||
    UNQUALIFIED_RELEASE_EVIDENCE,
  qualificationEvidenceRef = process.env.KF_UPGRADE_QUALIFICATION_REF ||
    bundledManifest.qualificationEvidenceRef,
  output,
}) {
  if (!fs.statSync(cliArtifact).isFile()) {
    throw new Error(`CLI artifact is not a file: ${cliArtifact}`);
  }
  const manifest = {
    ...bundledManifest,
    artifacts: [
      ...bundledManifest.artifacts.filter((item) => item.kind !== 'cli'),
      {
        kind: 'cli',
        url: artifactUrl,
        size: fs.statSync(cliArtifact).size,
        digest: `sha256:${sha256File(cliArtifact)}`,
        signature: artifactSignature,
      },
    ],
    qualificationEvidenceRef,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function assertUpgradePublicationEligible(
  manifest,
  requiredSurface = 'desktop',
  qualificationEvidence = null,
  qualificationOptions = {},
) {
  if (manifest?.schema !== RELEASE_SCHEMA) {
    throw new Error('unsupported release manifest schema');
  }
  if (!/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '')) {
    throw new Error('release manifest source commit is invalid');
  }
  if (
    String(manifest.qualificationEvidenceRef || '').startsWith(
      UNQUALIFIED_RELEASE_EVIDENCE,
    )
  ) {
    throw new Error('release manifest has no retained qualification evidence');
  }
  const kinds = new Set();
  for (const artifact of manifest.artifacts || []) {
    kinds.add(artifact.kind);
    if (
      !artifact.signature ||
      artifact.signature === UNQUALIFIED_RELEASE_EVIDENCE
    ) {
      throw new Error(`${artifact.kind} artifact has no signing evidence`);
    }
    if (
      (artifact.kind === 'desktop' || artifact.kind === 'cli') &&
      !/^https:\/\//.test(artifact.url)
    ) {
      throw new Error(`${artifact.kind} update artifact must use HTTPS`);
    }
  }
  if (!kinds.has('runtime') || !kinds.has(requiredSurface)) {
    throw new Error(
      `${requiredSurface} release must bind runtime and ${requiredSurface} artifacts`,
    );
  }
  verifyUpgradeQualificationEvidence(
    manifest,
    qualificationEvidence,
    requiredSurface,
    loadUpgradeQualificationContract(),
    qualificationOptions,
  );
  return manifest;
}
