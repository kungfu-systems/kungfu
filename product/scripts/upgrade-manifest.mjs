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
import {
  internalSymlinkTarget,
  isPythonBytecodePath,
  sha256Tree,
} from './compatibility.mjs';
import { contentRoot } from './release-channel-index.mjs';

export const UNQUALIFIED_RELEASE_EVIDENCE = 'unqualified-local-build';
const DOCUMENTATION_URL = 'https://www.kungfu.tech/docs/guides/upgrading';
const RELEASE_SCHEMA = 'kungfu.product-upgrade.manifest/v1';
const RELEASE_CUT_SCHEMA = 'kungfu.product-release-cut/v1';
const PLATFORM_SLICE_SCHEMA = 'kungfu.product-release-platform-slice/v1';
const CUT_BINDING_FIELDS = new Set([
  'manifestIdentityRoot',
  'releaseCut',
  'releaseCutRoot',
  'platformSliceRoot',
  'cutTransition',
]);
const MANIFEST_IDENTITY_EXCLUDED_FIELDS = new Set([
  ...CUT_BINDING_FIELDS,
  'artifacts',
  'qualificationEvidenceRef',
]);

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

const releaseRuntimePath = (file) => !isPythonBytecodePath(file);

function treeSize(root) {
  let size = 0;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!releaseRuntimePath(full)) continue;
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

function exactRootOrContent(value) {
  return /^sha256:[a-f0-9]{64}$/.test(value || '') ? value : contentRoot(value);
}

function sortedRoots(values) {
  return [...new Set(values.filter(Boolean).map(exactRootOrContent))].sort();
}

function cutFreeManifest(manifest) {
  return Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !CUT_BINDING_FIELDS.has(key)),
  );
}

function manifestIdentity(manifest) {
  return Object.fromEntries(
    Object.entries(manifest).filter(
      ([key]) => !MANIFEST_IDENTITY_EXCLUDED_FIELDS.has(key),
    ),
  );
}

function artifactIdentity(artifact) {
  return {
    kind: artifact.kind,
    url: artifact.url,
    size: artifact.size,
    digest: artifact.digest,
    signature: artifact.signature,
  };
}

export function bindProductReleaseCut(
  manifest,
  {
    parentReleaseCutRoots = String(
      process.env.KF_PARENT_RELEASE_CUT_ROOTS ||
        process.env.KUNGFU_SELECTED_RELEASE_CUT_ROOT ||
        '',
    )
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    sourceSettlementRoot = process.env.KF_SOURCE_SETTLEMENT_ROOT,
  } = {},
) {
  const base = cutFreeManifest(manifest);
  const manifestIdentityRoot = contentRoot(manifestIdentity(base));
  const localEvidence =
    String(base.qualificationEvidenceRef || '').startsWith(
      UNQUALIFIED_RELEASE_EVIDENCE,
    ) ||
    (base.artifacts || []).some(
      (artifact) =>
        !artifact.signature ||
        artifact.signature === UNQUALIFIED_RELEASE_EVIDENCE,
    );
  const trustDomain = localEvidence ? 'shifu-local' : 'public';
  const qualificationEvidenceRoots = sortedRoots([
    base.qualificationEvidenceRef,
  ]);
  const signingEvidenceRoots =
    trustDomain === 'public'
      ? sortedRoots(
          (base.artifacts || []).map((artifact) => artifact.signature),
        )
      : [];
  const platformSlice = {
    schema: PLATFORM_SLICE_SCHEMA,
    platform: base.platform,
    architecture: base.architecture,
    manifestIdentityRoot,
    artifactRoot: contentRoot((base.artifacts || []).map(artifactIdentity)),
    qualificationEvidenceRoots,
    signingEvidenceRoots,
  };
  platformSlice.platformSliceRoot = contentRoot(platformSlice);
  const compatibility = {
    controlProtocolRange: base.controlProtocolRange,
    peerWireProtocolRange: base.peerWireProtocolRange,
    journalSchemaReadRange: base.journalSchemaReadRange,
    journalSchemaWriteVersion: base.journalSchemaWriteVersion,
    minimumSupportedFrontend: base.minimumSupportedFrontend,
    minimumSupportedRuntime: base.minimumSupportedRuntime,
  };
  const migration = {
    migrationClass: base.migrationClass,
    rollbackClass: base.rollbackClass,
  };
  const releaseCut = {
    schema: RELEASE_CUT_SCHEMA,
    productVersion: base.productVersion,
    parentReleaseCutRoots: sortedRoots(parentReleaseCutRoots),
    sourceSettlementRoot: exactRootOrContent(
      sourceSettlementRoot || {
        sourceCommit: base.sourceCommit,
      },
    ),
    semanticIdentityRoot: contentRoot({
      productVersion: base.productVersion,
      releaseChannel: base.releaseChannel,
      runtimeBuildId: base.runtimeBuildId,
      frontendBuildId: base.frontendBuildId,
    }),
    productAssemblyRoot: contentRoot({
      runtimeArtifactDigest: base.runtimeArtifactDigest,
      artifacts: (base.artifacts || []).map(artifactIdentity),
    }),
    compatibilityContractRoot: contentRoot(compatibility),
    migrationContractRoot: contentRoot(migration),
    platformSlices: [platformSlice],
    qualificationEvidenceRoots,
    signingEvidenceRoots,
    publicationPolicy: {
      trustDomain,
      publicationEligible: trustDomain === 'public',
      immutable: true,
      eligibleChannels:
        trustDomain === 'public' ? [base.releaseChannel].sort() : [],
    },
    omissionRoots: [],
    waiverRoots: [],
  };
  releaseCut.releaseCutRoot = contentRoot(releaseCut);
  return {
    ...base,
    manifestIdentityRoot,
    releaseCut,
    releaseCutRoot: releaseCut.releaseCutRoot,
    platformSliceRoot: platformSlice.platformSliceRoot,
  };
}

export function platformUpgradeManifestName(version, platform, architecture) {
  return `kungfu-upgrade-${version}-${platform}-${architecture}.json`;
}

export function assertUpgradeIdentityConverged(bundled, releaseBase) {
  if (
    !bundled?.manifestIdentityRoot ||
    bundled.manifestIdentityRoot !== releaseBase?.manifestIdentityRoot
  ) {
    throw new Error(
      'CLI archive and desktop release base have divergent upgrade identities',
    );
  }
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
  const runtimeDigest = sha256Tree(runtimeRoot, {
    filter: releaseRuntimePath,
  });
  const runtimeBuildId = `runtime-${version}-${runtimeDigest.slice(0, 16)}`;
  const frontendBuildId = `product-${version}-${revision.slice(0, 16)}`;
  return bindProductReleaseCut({
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
  });
}

export function buildCliUpgradeManifest({
  stageRoot,
  layout,
  root = path.resolve(import.meta.dirname, '..', '..'),
}) {
  return buildBundledUpgradeManifest({
    root,
    runtimeRoot: path.join(stageRoot, layout.runtimeDirectory),
  });
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
  const manifest = bindProductReleaseCut({
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
  });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifest;
}

export function finalizeCliUpgradeManifest({
  bundledManifest,
  embeddedManifest = bundledManifest,
  cliArtifact,
  artifactUrl,
  artifactSignature = process.env.KF_CLI_ARTIFACT_SIGNATURE ||
    UNQUALIFIED_RELEASE_EVIDENCE,
  qualificationEvidenceRef = process.env.KF_UPGRADE_QUALIFICATION_REF ||
    bundledManifest.qualificationEvidenceRef,
  output,
}) {
  assertUpgradeIdentityConverged(embeddedManifest, bundledManifest);
  if (!fs.statSync(cliArtifact).isFile()) {
    throw new Error(`CLI artifact is not a file: ${cliArtifact}`);
  }
  const manifest = bindProductReleaseCut({
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
  });
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
