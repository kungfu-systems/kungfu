// SPDX-License-Identifier: Apache-2.0
// Build the release identity shared by the bundled runtime and the external
// desktop updater. Local packages remain explicitly unqualified; a remote
// update resolver must reject them until signing and qualification evidence is
// supplied by the release job.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
const BUILDCHAIN_RETAINED_EVIDENCE = 'buildchain-retained:';
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
  'localArtifact',
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

function treeSize(root, { filter = () => true } = {}) {
  let size = 0;
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (!filter(full, entry)) continue;
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

function localArtifactIdentity(artifact) {
  const stat = fs.statSync(artifact);
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(
      `local desktop artifact is not a file or directory: ${artifact}`,
    );
  }
  return {
    kind: 'desktop-local',
    format: stat.isDirectory() ? 'directory' : 'file',
    size: stat.isDirectory() ? treeSize(artifact) : stat.size,
    digest: `sha256:${
      stat.isDirectory() ? sha256Tree(artifact) : sha256File(artifact)
    }`,
  };
}

export function resolveDesktopLocalArtifact(
  desktopDistDir,
  updaterName,
  platform = process.platform,
) {
  if (platform !== 'darwin') return path.join(desktopDistDir, updaterName);
  const apps = fs
    .readdirSync(desktopDistDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('mac'))
    .flatMap((entry) =>
      fs
        .readdirSync(path.join(desktopDistDir, entry.name), {
          withFileTypes: true,
        })
        .filter(
          (candidate) =>
            candidate.isDirectory() && candidate.name.endsWith('.app'),
        )
        .map((candidate) =>
          path.join(desktopDistDir, entry.name, candidate.name),
        ),
    );
  if (apps.length !== 1) {
    throw new Error(
      `expected one local macOS app artifact, found: ${apps.join(', ') || 'none'}`,
    );
  }
  return apps[0];
}

export function desktopUpdaterArtifact(files, platform = process.platform) {
  const suffix = {
    darwin: '.zip',
    win32: '.exe',
    linux: '.AppImage',
  }[platform];
  if (!suffix) throw new Error(`unsupported desktop platform: ${platform}`);
  const matches = files
    .filter((file) => file.endsWith(suffix))
    .sort((left, right) => left.localeCompare(right));
  if (matches.length !== 1) {
    throw new Error(
      `expected one ${platform} desktop updater artifact, found: ${matches.join(', ') || 'none'}`,
    );
  }
  return matches[0];
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
    sourceBuild = process.env.KUNGFU_BUILDCHAIN_SOURCE_BUILD === '1',
  } = {},
) {
  const base = cutFreeManifest(manifest);
  const manifestIdentityRoot = contentRoot(manifestIdentity(base));
  const localOnlyEvidence = (value) =>
    String(value || '').startsWith(UNQUALIFIED_RELEASE_EVIDENCE) ||
    (sourceBuild &&
      String(value || '').startsWith(BUILDCHAIN_RETAINED_EVIDENCE));
  const localEvidence =
    localOnlyEvidence(base.qualificationEvidenceRef) ||
    (base.artifacts || []).some(
      (artifact) =>
        !artifact.signature || localOnlyEvidence(artifact.signature),
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
    artifactRoot: contentRoot({
      releaseArtifacts: (base.artifacts || []).map(artifactIdentity),
      localArtifact: base.localArtifact || null,
    }),
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
      localArtifact: base.localArtifact || null,
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
  sourceBuild = process.env.KUNGFU_BUILDCHAIN_SOURCE_BUILD === '1',
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
  const frontendBuildId = `product-${version}-${revision.slice(0, 12)}-${runtimeDigest.slice(0, 16)}`;
  return bindProductReleaseCut(
    {
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
          size: treeSize(runtimeRoot, { filter: releaseRuntimePath }),
          digest: `sha256:${runtimeDigest}`,
          signature: runtimeSignature,
        },
      ],
      qualificationEvidenceRef,
      documentationUrl: DOCUMENTATION_URL,
    },
    { sourceBuild },
  );
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
  localArtifact = desktopArtifact,
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
    localArtifact: localArtifactIdentity(localArtifact),
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

const MACOS_FINALIZATION_SCHEMA =
  'kungfu.macos-release-artifact-finalization-receipt/v1';
const EXACT_SHA = /^[0-9a-f]{40}$/u;
const FINAL_MACOS_ARTIFACT = /^Kungfu-Episodes-.+-macos-arm64\.(dmg|zip)$/u;
const BUILDER_MACOS_ARTIFACT =
  /^Kungfu Episodes-.+-arm64(?:-mac)?\.(dmg|zip)$/u;

function releaseAssert(condition, message) {
  if (!condition) throw new Error(message);
}

function releaseBelow(root, value, label) {
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  releaseAssert(
    relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `${label} must resolve below the workspace`,
  );
  return target;
}

function releaseRelative(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

async function releaseFileDescriptor(root, target, kind) {
  const stat = fs.statSync(target);
  releaseAssert(stat.isFile(), `${kind} is not a regular file: ${target}`);
  releaseAssert(!fs.lstatSync(target).isSymbolicLink(), `${kind} is a symlink`);
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
  return {
    kind,
    path: releaseRelative(root, target),
    size: stat.size,
    sha256: `sha256:${hash.digest('hex')}`,
  };
}

function oneSigningEvidence(result, predicate, label) {
  const matches = (result.evidence || []).filter(predicate);
  releaseAssert(matches.length === 1, `signing result must bind one ${label}`);
  return matches[0];
}

export function macosReleaseFinalizationReceiptRoot(receipt) {
  const { receiptRoot: _receiptRoot, ...subject } = receipt;
  return contentRoot(subject);
}

async function signedMacosAuthority({
  root,
  sourceSha,
  releaseRoot,
  credentialManifestFile,
  signingResultFile,
  signingReceiptFile,
}) {
  const manifest = readJson(credentialManifestFile);
  const result = readJson(signingResultFile);
  const receipt = readJson(signingReceiptFile);
  releaseAssert(
    manifest.contract === 'kungfu-buildchain-artifact' &&
      manifest.lifecycle?.stage === 'credential-island' &&
      manifest.lifecycle?.executed === true &&
      manifest.platform?.id === 'macos-arm64-credential' &&
      manifest.git?.sha === sourceSha &&
      manifest.expectedArtifacts?.ok === true,
    'credential manifest is not the accepted macOS credential-island output',
  );
  releaseAssert(
    result.contract === 'kungfu-buildchain-artifact-signing-result/v1' &&
      result.verification?.status === 'passed' &&
      result.source?.sha === sourceSha,
    'Buildchain desktop signing result did not pass for the exact source',
  );
  releaseAssert(
    receipt.contract === 'kungfu-buildchain-artifact-signing-receipt/v1' &&
      receipt.status === 'passed' &&
      result.requestDigest === receipt.requestDigest &&
      result.evidenceDigest === receipt.result?.evidenceDigest,
    'Buildchain desktop signing result and receipt disagree',
  );
  const prefix = `${releaseRelative(root, releaseRoot)}/`;
  const finalFiles = (manifest.files || []).filter((file) => {
    const relative = String(file.path || '').slice(prefix.length);
    return (
      String(file.path || '').startsWith(prefix) &&
      !relative.includes('/') &&
      FINAL_MACOS_ARTIFACT.test(relative)
    );
  });
  releaseAssert(
    finalFiles.filter((file) => file.path.endsWith('.dmg')).length === 1 &&
      finalFiles.filter((file) => file.path.endsWith('.zip')).length === 1,
    'credential manifest must retain exactly one final macOS DMG and ZIP',
  );
  const credentialManifest = await releaseFileDescriptor(
    root,
    credentialManifestFile,
    'credential-artifact-manifest',
  );
  releaseAssert(
    oneSigningEvidence(
      result,
      (entry) =>
        entry?.kind === 'credential-artifact-manifest' &&
        entry?.path === 'credential-artifact/manifest.json',
      'credential artifact manifest',
    ).digest === credentialManifest.sha256,
    'signing result does not bind the exact credential manifest',
  );
  const retained = [];
  for (const file of finalFiles) {
    const descriptor = await releaseFileDescriptor(
      root,
      releaseBelow(root, file.path, 'credential artifact'),
      file.path.endsWith('.dmg') ? 'installer-dmg' : 'updater-zip',
    );
    releaseAssert(
      descriptor.size === file.size &&
        descriptor.sha256 === `sha256:${String(file.sha256).toLowerCase()}` &&
        oneSigningEvidence(
          result,
          (entry) => entry?.path === `credential-artifact/${file.path}`,
          file.path,
        ).digest === descriptor.sha256,
      `signed artifact evidence mismatch: ${file.path}`,
    );
    retained.push(descriptor);
  }
  return {
    credentialManifestDigest: credentialManifest.sha256,
    requestDigest: result.requestDigest,
    evidenceDigest: result.evidenceDigest,
    retained: retained.sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  };
}

export async function finalizeMacosReleaseArtifacts({
  workspace = process.cwd(),
  releaseRoot = 'product/release',
  desktopRoot = 'product/release/desktop',
  credentialManifest = '.buildchain/artifacts/signing/macos-arm64/kungfu-desktop-macos-arm64/credential-artifact/manifest.json',
  signingResult = '.buildchain/artifacts/signing/macos-arm64/kungfu-desktop-macos-arm64/result.json',
  signingReceipt = '.buildchain/artifacts/signing/macos-arm64/kungfu-desktop-macos-arm64/receipt.json',
  output = 'product/release/qualification/macos-release-artifact-finalization.json',
  sourceSha = process.env.BUILDCHAIN_SOURCE_SHA || '',
  sourceTreeSha = process.env.BUILDCHAIN_SOURCE_TREE_SHA || '',
  runtimeSha = process.env.BUILDCHAIN_RUNTIME_SHA || '',
} = {}) {
  const root = path.resolve(workspace);
  releaseAssert(EXACT_SHA.test(sourceSha), 'exact source commit is required');
  releaseAssert(EXACT_SHA.test(sourceTreeSha), 'exact source tree is required');
  releaseAssert(
    !runtimeSha || EXACT_SHA.test(runtimeSha),
    'invalid runtime SHA',
  );
  const release = releaseBelow(root, releaseRoot, 'release root');
  const desktop = releaseBelow(root, desktopRoot, 'desktop root');
  const manifestFile = releaseBelow(
    root,
    credentialManifest,
    'credential manifest',
  );
  const resultFile = releaseBelow(root, signingResult, 'signing result');
  const signingReceiptFile = releaseBelow(
    root,
    signingReceipt,
    'signing receipt',
  );
  const outputFile = releaseBelow(root, output, 'finalization receipt');
  const authority = await signedMacosAuthority({
    root,
    sourceSha,
    releaseRoot: release,
    credentialManifestFile: manifestFile,
    signingResultFile: resultFile,
    signingReceiptFile,
  });
  releaseAssert(
    fs.existsSync(desktop) && fs.statSync(desktop).isDirectory(),
    `desktop release directory not found: ${desktop}`,
  );
  const names = fs
    .readdirSync(desktop, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const archives = names.filter((name) => BUILDER_MACOS_ARTIFACT.test(name));
  const blockmaps = names.filter(
    (name) =>
      name.endsWith('.blockmap') && archives.includes(name.slice(0, -9)),
  );
  const orphans = names.filter(
    (name) =>
      (name.endsWith('.dmg.blockmap') || name.endsWith('.zip.blockmap')) &&
      !blockmaps.includes(name),
  );
  releaseAssert(!orphans.length, `orphan blockmaps: ${orphans.join(', ')}`);
  if (fs.existsSync(outputFile)) {
    releaseAssert(
      !archives.length && !blockmaps.length,
      'finalization receipt exists while redundant archives are present',
    );
    const prior = readJson(outputFile);
    releaseAssert(
      prior.schema === MACOS_FINALIZATION_SCHEMA &&
        prior.status === 'complete' &&
        prior.source?.sha === sourceSha &&
        prior.source?.tree === sourceTreeSha &&
        prior.source?.buildchainRuntimeSha === runtimeSha &&
        prior.receiptRoot === macosReleaseFinalizationReceiptRoot(prior) &&
        prior.signing?.credentialManifestDigest ===
          authority.credentialManifestDigest &&
        prior.signing?.requestDigest === authority.requestDigest &&
        prior.signing?.evidenceDigest === authority.evidenceDigest &&
        contentRoot(prior.retained || []) === contentRoot(authority.retained),
      'existing macOS artifact finalization receipt is invalid',
    );
    for (const retained of authority.retained) {
      const observed = await releaseFileDescriptor(
        root,
        releaseBelow(root, retained.path, 'retained artifact'),
        retained.kind,
      );
      releaseAssert(
        observed.size === retained.size && observed.sha256 === retained.sha256,
        `retained artifact drifted: ${retained.path}`,
      );
    }
    for (const metadata of prior.preservedMetadata || []) {
      const observed = await releaseFileDescriptor(
        root,
        releaseBelow(root, metadata.path, 'preserved metadata'),
        metadata.kind,
      );
      releaseAssert(
        observed.size === metadata.size && observed.sha256 === metadata.sha256,
        `preserved metadata drifted: ${metadata.path}`,
      );
    }
    for (const removed of prior.removed || [])
      releaseAssert(
        !fs.existsSync(releaseBelow(root, removed.path, 'removed artifact')),
        `removed artifact reappeared: ${removed.path}`,
      );
    return { receipt: prior, receiptFile: outputFile, reused: true };
  }
  releaseAssert(
    archives.filter((name) => name.endsWith('.dmg')).length === 1 &&
      archives.filter((name) => name.endsWith('.zip')).length === 1,
    `expected one electron-builder DMG and ZIP, found: ${archives.join(', ') || 'none'}`,
  );
  const updateMetadata = names.filter((name) => name.endsWith('-mac.yml'));
  releaseAssert(
    updateMetadata.length === 1,
    `expected one electron-builder macOS update metadata file, found: ${updateMetadata.join(', ') || 'none'}`,
  );
  const removed = [];
  for (const name of [...archives, ...blockmaps].sort()) {
    removed.push(
      await releaseFileDescriptor(
        root,
        path.join(desktop, name),
        name.endsWith('.blockmap')
          ? 'electron-builder-blockmap'
          : 'electron-builder-archive',
      ),
    );
  }
  const preservedMetadata = [];
  for (const name of names.filter((entry) =>
    /\.(?:json|ya?ml)$/u.test(entry),
  )) {
    preservedMetadata.push(
      await releaseFileDescriptor(
        root,
        path.join(desktop, name),
        'desktop-update-metadata',
      ),
    );
  }
  for (const artifact of removed)
    fs.rmSync(releaseBelow(root, artifact.path, 'redundant artifact'));
  const receipt = {
    schema: MACOS_FINALIZATION_SCHEMA,
    status: 'complete',
    platform: 'macos-arm64',
    source: {
      sha: sourceSha,
      tree: sourceTreeSha,
      buildchainRuntimeSha: runtimeSha,
    },
    signing: {
      credentialManifest: releaseRelative(root, manifestFile),
      credentialManifestDigest: authority.credentialManifestDigest,
      requestDigest: authority.requestDigest,
      evidenceDigest: authority.evidenceDigest,
    },
    retained: authority.retained,
    removed,
    removedTotalBytes: removed.reduce(
      (sum, artifact) => sum + artifact.size,
      0,
    ),
    preservedMetadata,
    claims: {
      canonicalSignedInstallerRetained: true,
      canonicalSignedUpdaterZipRetained: true,
      electronBuilderIntermediatesRemoved: true,
      updaterMetadataPreserved: true,
    },
    nonClaims: [
      'does-not-create-or-replace-signed-payloads',
      'does-not-grant-signing-notarization-or-publication-authority',
      'does-not-change-electron-updater-artifact-selection',
    ],
  };
  receipt.receiptRoot = macosReleaseFinalizationReceiptRoot(receipt);
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`);
    fs.renameSync(temporary, outputFile);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return { receipt, receiptFile: outputFile, reused: false };
}

async function runMacosFinalizationCli() {
  const result = await finalizeMacosReleaseArtifacts();
  process.stdout.write(
    `${JSON.stringify({
      schema: MACOS_FINALIZATION_SCHEMA,
      status: result.receipt.status,
      reused: result.reused,
      receiptRoot: result.receipt.receiptRoot,
      removedTotalBytes: result.receipt.removedTotalBytes,
      retained: result.receipt.retained.map((artifact) => artifact.path),
    })}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.argv[2] === 'finalize-macos-release-artifacts'
) {
  runMacosFinalizationCli().catch((error) => {
    process.stderr.write(`[upgrade-manifest] ${error.message}\n`);
    process.exitCode = 1;
  });
}
