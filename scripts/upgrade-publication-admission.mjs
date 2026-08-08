// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertUpgradePublicationEligible } from '../product/scripts/upgrade-manifest.mjs';
import {
  loadUpgradeQualificationContract,
  qualificationContentRoot,
} from './upgrade-qualification.mjs';

const RELEASE_MANIFEST_SCHEMA = 'kungfu.product-upgrade.manifest/v1';
const RELEASE_CANDIDATE_CONTRACT =
  'kungfu-buildchain-release-candidate-passport';
const CREDENTIAL_POLICY_PATH =
  'docs/qualification/gates/macos-credential-island-policy.json';
const CREDENTIAL_EVIDENCE_FILE = 'credential-island-evidence.json';
const CANDIDATE_PLATFORM_MANIFEST_FILE = 'manifest.json';
const EXPECTED_CANDIDATE_BUNDLE_ROLES = {
  'credential-island': 1,
  'product-support': 1,
  'product-upgrade': 3,
};
const EXPECTED_CANDIDATE_PLATFORM_ROLES = {
  'credential-island': ['macos-arm64-credential'],
  'product-support': ['linux-arm64'],
  'product-upgrade': ['darwin-arm64', 'linux-x64', 'win32-x64'],
};
export const PRODUCT_UPGRADE_PUBLICATION_ADMISSION_SCHEMA =
  'kungfu.product-upgrade.publication-admission/v1';
export const PRODUCT_UPGRADE_PUBLICATION_CAPSULE_SCHEMA =
  'kungfu.product-upgrade.publication-candidate-capsule/v1';
export const PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE =
  'product-upgrade-publication-admission.json';
export const PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE =
  'product-upgrade-publication-capsule.json';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA1_PATTERN = /^[a-f0-9]{40}$/i;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const NOTARY_ID_PATTERN = /^[a-f0-9-]{36}$/i;

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(
      `failed to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function filesNamed(root, name) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name === name) matches.push(fullPath);
    }
  };
  visit(root);
  return matches.sort((left, right) => left.localeCompare(right));
}

function upgradeManifestFiles(root) {
  const matches = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (
        entry.isFile() &&
        /^kungfu-upgrade-.+-(darwin|linux|win32)-(arm64|x64)\.json$/.test(
          entry.name,
        )
      ) {
        matches.push(fullPath);
      }
    }
  };
  visit(root);
  return matches.sort((left, right) => left.localeCompare(right));
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
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function sha256File(filePath) {
  const digest = createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest('hex');
}

function fileRoot(filePath) {
  return `sha256:${sha256File(filePath)}`;
}

function exactRoot(value, label) {
  const root = String(value || '').toLowerCase();
  if (!SHA256_PATTERN.test(root))
    throw new Error(`${label} is not a SHA-256 root`);
  return root;
}

function safeRelative(root, filePath, label) {
  const relative = path
    .relative(path.resolve(root), path.resolve(filePath))
    .split(path.sep)
    .join('/');
  if (
    !relative ||
    relative.startsWith('../') ||
    relative === '..' ||
    path.posix.isAbsolute(relative)
  ) {
    throw new Error(`${label} is outside its candidate root`);
  }
  return relative;
}

function candidateBundleIdentity(directory) {
  const platformManifestPath = path.join(
    directory,
    CANDIDATE_PLATFORM_MANIFEST_FILE,
  );
  const credentialEvidence = filesNamed(directory, CREDENTIAL_EVIDENCE_FILE);
  if (credentialEvidence.length > 0) {
    if (!fs.existsSync(platformManifestPath)) {
      throw new Error('credential-island bundle has no platform manifest');
    }
    const manifest = readJson(
      platformManifestPath,
      'credential-island platform manifest',
    );
    return {
      role: 'credential-island',
      platformId: String(manifest.platform?.id || ''),
    };
  }
  const upgradeManifests = upgradeManifestFiles(directory);
  if (upgradeManifests.length > 0) {
    const platformIds = new Set(
      upgradeManifests.map((manifestPath) =>
        platformIdentity(readJson(manifestPath, 'upgrade platform manifest')),
      ),
    );
    if (platformIds.size !== 1) {
      throw new Error(
        `product-upgrade bundle has multiple platform roles: ${[...platformIds].join(', ')}`,
      );
    }
    return { role: 'product-upgrade', platformId: [...platformIds][0] };
  }
  if (fs.existsSync(platformManifestPath)) {
    const manifest = readJson(
      platformManifestPath,
      'product-support platform manifest',
    );
    return {
      role: 'product-support',
      platformId: String(manifest.platform?.id || ''),
    };
  }
  return null;
}

function candidateInventory(payloadRoot) {
  const resolvedRoot = fs.realpathSync(payloadRoot);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `candidate payload contains a symbolic link: ${fullPath}`,
        );
      }
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) {
        files.push({
          path: safeRelative(resolvedRoot, fullPath, 'candidate file'),
          size: fs.statSync(fullPath).size,
          root: fileRoot(fullPath),
        });
      }
    }
  };
  const bundleEntries = fs
    .readdirSync(resolvedRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const directory = path.join(resolvedRoot, entry.name);
      return { directory, identity: candidateBundleIdentity(directory) };
    })
    .filter((entry) => entry.identity)
    .sort((left, right) => left.directory.localeCompare(right.directory));
  const bundleRoots = bundleEntries.map((entry) => entry.directory);
  for (const bundleRoot of bundleRoots) visit(bundleRoot);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const bundles = bundleEntries.map(({ directory: bundleRoot, identity }) => {
    const name = path.basename(bundleRoot);
    const bundleFiles = files.filter((file) =>
      file.path.startsWith(`${name}/`),
    );
    return {
      name,
      ...identity,
      fileCount: bundleFiles.length,
      root: contentRoot(bundleFiles),
    };
  });
  return { files, bundles };
}

function candidateArtifactRoot(payloadRoot) {
  const { files, bundles } = candidateInventory(payloadRoot);
  if (files.length === 0)
    throw new Error('candidate payload contains no files');
  return { files, bundles, root: contentRoot(files) };
}

function assertCandidateBundleRoles(bundles) {
  const counts = Object.fromEntries(
    Object.keys(EXPECTED_CANDIDATE_BUNDLE_ROLES).map((role) => [role, 0]),
  );
  for (const bundle of bundles) {
    if (!(bundle.role in counts)) {
      throw new Error(
        `candidate payload has an unsupported role: ${bundle.role}`,
      );
    }
    counts[bundle.role] += 1;
  }
  for (const [role, expected] of Object.entries(
    EXPECTED_CANDIDATE_BUNDLE_ROLES,
  )) {
    if (counts[role] !== expected) {
      throw new Error(
        `candidate payload requires exactly ${expected} ${role} bundle${expected === 1 ? '' : 's'}; found ${counts[role]}`,
      );
    }
    const platforms = bundles
      .filter((bundle) => bundle.role === role)
      .map((bundle) => bundle.platformId)
      .sort();
    if (
      JSON.stringify(platforms) !==
      JSON.stringify(EXPECTED_CANDIDATE_PLATFORM_ROLES[role])
    ) {
      throw new Error(
        `candidate ${role} platform roles must be ${EXPECTED_CANDIDATE_PLATFORM_ROLES[role].join(', ')}; found ${platforms.join(', ') || '<none>'}`,
      );
    }
  }
}

function candidatePlatformRoot(bundles) {
  return contentRoot(
    bundles.map(({ name, role, platformId, root }) => ({
      name,
      role,
      platformId,
      root,
    })),
  );
}

function toolingRoot() {
  const files = [
    'scripts/upgrade-publication-admission.mjs',
    'scripts/upgrade-qualification.mjs',
    'product/scripts/upgrade-manifest.mjs',
  ].map((relativePath) => ({
    path: relativePath,
    root: fileRoot(path.join(ROOT, relativePath)),
  }));
  return contentRoot(files);
}

function policyRoot() {
  return contentRoot({
    credentialIsland: credentialIslandPolicy(),
    upgradeQualification: loadUpgradeQualificationContract(),
  });
}

function findExactlyOne(root, name, label) {
  const matches = filesNamed(root, name);
  if (matches.length !== 1) {
    throw new Error(
      `${label} must occur exactly once; found ${matches.length}`,
    );
  }
  return matches[0];
}

function sha256Summary(files) {
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(`${file.path}\0${file.size}\0${file.sha256}\n`);
  }
  return digest.digest('hex');
}

function credentialIslandPolicy() {
  const policy = readJson(
    path.join(ROOT, CREDENTIAL_POLICY_PATH),
    'macOS credential-island policy',
  );
  if (policy.schema !== 'kungfu.macos-credential-island-policy/v1') {
    throw new Error('macOS credential-island policy schema is unsupported');
  }
  if (
    !policy.repository ||
    !policy.environment ||
    !policy.platformId ||
    !policy.manifestContract ||
    !policy.evidenceSchema ||
    !policy.app?.bundleId ||
    !['arm64', 'x64'].includes(policy.app?.architecture) ||
    !/^[A-Z0-9]{10}$/.test(policy.identity?.teamId || '') ||
    !SHA1_PATTERN.test(policy.identity?.certificateSha1 || '') ||
    !Array.isArray(policy.requiredVerifications) ||
    policy.requiredVerifications.length === 0
  ) {
    throw new Error('macOS credential-island policy is incomplete');
  }
  return policy;
}

function verifyManifestFileBytes(bundleRoot, file) {
  if (
    typeof file?.path !== 'string' ||
    path.posix.isAbsolute(file.path) ||
    file.path.split('/').includes('..') ||
    !file.path.startsWith('product/release/')
  ) {
    throw new Error('credential manifest contains an unsafe output path');
  }
  const filePath = path.resolve(bundleRoot, file.path);
  const relative = path.relative(path.resolve(bundleRoot), filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('credential manifest output escapes its payload bundle');
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`credential manifest output is missing: ${file.path}`);
  }
  if (fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(
      `credential manifest output is a symbolic link: ${file.path}`,
    );
  }
  const realRelative = path.relative(
    fs.realpathSync(bundleRoot),
    fs.realpathSync(filePath),
  );
  if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
    throw new Error('credential manifest output resolves outside its payload');
  }
  const size = fs.statSync(filePath).size;
  if (size !== file.size) {
    throw new Error(
      `credential manifest size mismatch for ${file.path}: manifest ${file.size}, payload ${size}`,
    );
  }
  const digest = sha256File(filePath);
  if (digest !== file.sha256) {
    throw new Error(
      `credential manifest digest mismatch for ${file.path}: manifest ${file.sha256}, payload ${digest}`,
    );
  }
  return filePath;
}

function verifyCredentialIslandBundle({
  bundleRoot,
  expectedVersion,
  acceptedSources,
  policy,
}) {
  const evidencePaths = filesNamed(bundleRoot, CREDENTIAL_EVIDENCE_FILE);
  if (evidencePaths.length === 0) return null;
  if (evidencePaths.length !== 1) {
    throw new Error(
      `credential payload ${bundleRoot} must contain exactly one ${CREDENTIAL_EVIDENCE_FILE}; found ${evidencePaths.length}`,
    );
  }
  const manifestPaths = filesNamed(bundleRoot, 'manifest.json');
  if (manifestPaths.length !== 1) {
    throw new Error(
      `credential payload ${bundleRoot} must contain exactly one manifest.json; found ${manifestPaths.length}`,
    );
  }
  const manifest = readJson(
    manifestPaths[0],
    'macOS credential-island artifact manifest',
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.contract !== policy.manifestContract
  ) {
    throw new Error('credential artifact manifest contract is unsupported');
  }
  if (
    manifest.platform?.id !== policy.platformId ||
    manifest.platform?.os !== 'macos' ||
    manifest.platform?.arch !== policy.app.architecture
  ) {
    throw new Error(
      'credential artifact platform identity is not authoritative',
    );
  }
  if (
    manifest.git?.repository !== policy.repository ||
    !acceptedSources.has(manifest.git?.sha)
  ) {
    throw new Error(
      'credential artifact source is not bound by the release-candidate passport',
    );
  }
  if (
    manifest.lifecycle?.stage !== 'credential-island' ||
    manifest.lifecycle?.commandSource !== 'buildchain-action' ||
    manifest.lifecycle?.executed !== true ||
    manifest.expectedArtifacts?.ok !== true ||
    manifest.expectedArtifacts?.source !== policy.evidenceSchema
  ) {
    throw new Error('credential artifact lifecycle did not qualify');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 3) {
    throw new Error(
      `credential artifact must contain exactly three authoritative files; found ${manifest.files?.length || 0}`,
    );
  }
  const files = [...manifest.files].sort((left, right) =>
    String(left.path).localeCompare(String(right.path)),
  );
  if (
    new Set(files.map((file) => file.path)).size !== files.length ||
    files.some(
      (file) =>
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        !/^[a-f0-9]{64}$/i.test(file.sha256 || ''),
    )
  ) {
    throw new Error('credential artifact file inventory is invalid');
  }
  const filePaths = new Map(
    files.map((file) => [
      path.posix.basename(file.path),
      verifyManifestFileBytes(bundleRoot, file),
    ]),
  );
  if (
    filePaths.size !== 3 ||
    !filePaths.has(CREDENTIAL_EVIDENCE_FILE) ||
    [...filePaths.keys()].filter((name) => name.endsWith('.dmg')).length !==
      1 ||
    [...filePaths.keys()].filter((name) => name.endsWith('.zip')).length !== 1
  ) {
    throw new Error(
      'credential artifact must contain one evidence JSON, one DMG, and one ZIP',
    );
  }
  const summary = manifest.summary;
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (
    summary?.contract !== 'kungfu-buildchain-artifact-summary' ||
    summary?.artifactName !== manifest.artifactName ||
    JSON.stringify(canonical(summary?.platform)) !==
      JSON.stringify(canonical(manifest.platform)) ||
    summary?.fileCount !== files.length ||
    summary?.totalBytes !== totalBytes ||
    summary?.digest !== sha256Summary(files)
  ) {
    throw new Error(
      'credential artifact summary does not bind exact payload bytes',
    );
  }

  const evidence = readJson(
    evidencePaths[0],
    'macOS credential-island evidence',
  );
  if (
    evidence.schema !== policy.evidenceSchema ||
    evidence.status !== 'accepted'
  ) {
    throw new Error('credential-island evidence was not accepted');
  }
  if (
    evidence.source?.repository !== policy.repository ||
    evidence.source?.sha !== manifest.git.sha ||
    !acceptedSources.has(evidence.source?.sha) ||
    !SHA1_PATTERN.test(evidence.source?.treeSha || '')
  ) {
    throw new Error('credential-island evidence source binding is invalid');
  }
  if (
    !SHA1_PATTERN.test(evidence.buildchain?.runtimeSha || '') ||
    !SHA256_PATTERN.test(evidence.input?.manifestSha256 || '') ||
    !SHA256_PATTERN.test(evidence.input?.archiveSha256 || '') ||
    !Number.isSafeInteger(evidence.input?.archiveBytes) ||
    evidence.input.archiveBytes < 1
  ) {
    throw new Error('credential-island sealed input binding is invalid');
  }
  if (
    evidence.app?.bundleId !== policy.app.bundleId ||
    evidence.app?.version !== expectedVersion ||
    evidence.app?.architecture !== policy.app.architecture
  ) {
    throw new Error('credential-island application identity is invalid');
  }
  if (
    String(evidence.identity?.certificateSha1 || '').toLowerCase() !==
      policy.identity.certificateSha1.toLowerCase() ||
    evidence.identity?.teamId !== policy.identity.teamId ||
    !String(evidence.identity?.certificateSubject || '').startsWith(
      'Developer ID Application:',
    ) ||
    !evidence.identity?.entitlementsProfile ||
    !SHA256_PATTERN.test(evidence.identity?.entitlementsSha256 || '')
  ) {
    throw new Error('credential-island signing identity is invalid');
  }
  for (const label of ['application', 'diskImage']) {
    if (
      evidence.notarization?.[label]?.status !== 'Accepted' ||
      !NOTARY_ID_PATTERN.test(evidence.notarization?.[label]?.id || '')
    ) {
      throw new Error(
        `credential-island ${label} notarization was not accepted`,
      );
    }
  }
  for (const check of policy.requiredVerifications) {
    if (evidence.verification?.[check] !== true) {
      throw new Error(`credential-island verification did not pass: ${check}`);
    }
  }
  const evidenceArtifacts = evidence.artifacts || [];
  if (
    evidenceArtifacts.length !== 2 ||
    new Set(evidenceArtifacts.map((artifact) => artifact.kind)).size !== 2
  ) {
    throw new Error('credential-island evidence artifact inventory is invalid');
  }
  for (const kind of ['dmg', 'zip']) {
    const artifact = evidenceArtifacts.find((item) => item.kind === kind);
    const file = files.find((item) => item.path.endsWith(`.${kind}`));
    if (
      !artifact ||
      !file ||
      artifact.name !== path.posix.basename(file.path) ||
      artifact.bytes !== file.size ||
      artifact.sha256 !== `sha256:${file.sha256}`
    ) {
      throw new Error(
        `credential-island ${kind.toUpperCase()} evidence does not bind the payload`,
      );
    }
  }
  return {
    bundleRoot,
    platformId: manifest.platform.id,
    manifestPath: manifestPaths[0],
    evidencePath: evidencePaths[0],
    runtimeSha: evidence.buildchain.runtimeSha,
    certificateSha1: evidence.identity.certificateSha1,
    notarizationIds: [
      evidence.notarization.application.id,
      evidence.notarization.diskImage.id,
    ],
  };
}

function artifactFileName(artifact) {
  let parsed;
  try {
    parsed = new URL(artifact.url);
  } catch {
    throw new Error(
      `${artifact.kind} artifact URL is invalid: ${artifact.url}`,
    );
  }
  const name = decodeURIComponent(path.posix.basename(parsed.pathname));
  if (!name) throw new Error(`${artifact.kind} artifact URL has no file name`);
  return name;
}

function verifyArtifactBytes(bundleRoot, artifact) {
  const name = artifactFileName(artifact);
  const matches = filesNamed(bundleRoot, name);
  if (matches.length !== 1) {
    throw new Error(
      `${artifact.kind} artifact ${name} must occur exactly once in ${bundleRoot}; found ${matches.length}`,
    );
  }
  const filePath = matches[0];
  const size = fs.statSync(filePath).size;
  if (size !== artifact.size) {
    throw new Error(
      `${artifact.kind} artifact size mismatch for ${name}: manifest ${artifact.size}, payload ${size}`,
    );
  }
  const digest = `sha256:${sha256File(filePath)}`;
  if (digest !== artifact.digest) {
    throw new Error(
      `${artifact.kind} artifact digest mismatch for ${name}: manifest ${artifact.digest}, payload ${digest}`,
    );
  }
}

function releaseCandidateSources(passport) {
  if (passport?.contract !== RELEASE_CANDIDATE_CONTRACT) {
    throw new Error('release-candidate passport contract is unsupported');
  }
  const sources = new Set(
    [
      passport.source?.headSha,
      passport.source?.mergeRefSha,
      passport.source?.builtSourceSha,
    ].filter((value) => /^[a-f0-9]{40}$/i.test(value || '')),
  );
  if (sources.size === 0) {
    throw new Error('release-candidate passport has no accepted source commit');
  }
  return sources;
}

function platformIdentity(manifest) {
  return `${manifest.platform}-${manifest.architecture}`;
}

function sortUpdateCampaigns(campaigns) {
  return campaigns.sort((left, right) =>
    [left.channel, left.platform, left.architecture, left.installSource]
      .join('/')
      .localeCompare(
        [
          right.channel,
          right.platform,
          right.architecture,
          right.installSource,
        ].join('/'),
      ),
  );
}

function projectUpdateCampaigns(platform, architecture, campaigns) {
  return sortUpdateCampaigns(
    campaigns.map((campaign) => ({
      platform,
      architecture,
      campaignRoot: campaign.campaignRoot,
      channelIndexRoot: campaign.candidate.channelIndexRoot,
      releasePassportRoot: campaign.candidate.releasePassportRoot,
      channel: campaign.channel,
      installSource: campaign.installSource,
      previousVersion: campaign.previousPublic.productVersion,
      targetVersion: campaign.candidate.productVersion,
      receiptRoot: campaign.result.receiptRoot,
    })),
  );
}

function verifyBundle({
  bundleRoot,
  evidenceFileName,
  expectedVersion,
  acceptedSources,
  releasePassportRoot,
}) {
  const manifestPaths = upgradeManifestFiles(bundleRoot);
  if (manifestPaths.length === 0) return null;
  const manifests = manifestPaths.map((filePath) =>
    readJson(filePath, 'upgrade release manifest'),
  );
  const identities = new Set(manifests.map(platformIdentity));
  if (identities.size !== 1) {
    throw new Error(
      `payload bundle ${bundleRoot} contains multiple upgrade platform identities: ${[...identities].join(', ')}`,
    );
  }
  const canonicalManifest = JSON.stringify(canonical(manifests[0]));
  if (
    manifests.some(
      (manifest) => JSON.stringify(canonical(manifest)) !== canonicalManifest,
    )
  ) {
    throw new Error(
      `payload bundle ${bundleRoot} contains divergent copies of its upgrade manifest`,
    );
  }
  const manifest = manifests[0];
  if (manifest.schema !== RELEASE_MANIFEST_SCHEMA) {
    throw new Error(`upgrade manifest schema is unsupported in ${bundleRoot}`);
  }
  if (manifest.productVersion !== expectedVersion) {
    throw new Error(
      `upgrade manifest version ${manifest.productVersion || '<empty>'} does not match publication ${expectedVersion}`,
    );
  }
  if (!acceptedSources.has(manifest.sourceCommit)) {
    throw new Error(
      `upgrade manifest source ${manifest.sourceCommit || '<empty>'} is not bound by the release-candidate passport`,
    );
  }

  const evidencePaths = filesNamed(bundleRoot, evidenceFileName);
  if (evidencePaths.length !== 1) {
    throw new Error(
      `payload bundle ${bundleRoot} must contain exactly one ${evidenceFileName}; found ${evidencePaths.length}`,
    );
  }
  const evidence = readJson(
    evidencePaths[0],
    'retained upgrade qualification evidence',
  );
  const qualificationOptions = { releasePassportRoot };
  assertUpgradePublicationEligible(
    manifest,
    'desktop',
    evidence,
    qualificationOptions,
  );
  assertUpgradePublicationEligible(
    manifest,
    'cli',
    evidence,
    qualificationOptions,
  );
  const artifacts = new Map(
    (manifest.artifacts || []).map((artifact) => [artifact.kind, artifact]),
  );
  verifyArtifactBytes(bundleRoot, artifacts.get('desktop'));
  verifyArtifactBytes(bundleRoot, artifacts.get('cli'));
  return {
    identity: platformIdentity(manifest),
    platform: manifest.platform,
    architecture: manifest.architecture,
    manifestPath: manifestPaths[0],
    manifestPaths: manifestPaths.length,
    evidenceRef: evidence.evidenceRef,
    updateCampaigns: projectUpdateCampaigns(
      manifest.platform,
      manifest.architecture,
      evidence.campaigns,
    ),
  };
}

export function verifyUpgradePublicationPayloads({
  payloadRoot,
  releaseCandidatePassportPath,
  expectedVersion,
  expectedPlatforms,
} = {}) {
  if (!payloadRoot || !fs.existsSync(payloadRoot)) {
    throw new Error(
      `Buildchain release-candidate payload root is missing: ${payloadRoot || '<empty>'}`,
    );
  }
  if (
    !releaseCandidatePassportPath ||
    !fs.existsSync(releaseCandidatePassportPath)
  ) {
    throw new Error(
      `Buildchain release-candidate passport is missing: ${releaseCandidatePassportPath || '<empty>'}`,
    );
  }
  if (!expectedVersion)
    throw new Error('expected publication version is required');

  const contract = loadUpgradeQualificationContract();
  const credentialPolicy = credentialIslandPolicy();
  const evidenceFileName = contract.publication?.evidenceFileName;
  if (!evidenceFileName) {
    throw new Error(
      'upgrade qualification contract has no publication evidence file name',
    );
  }
  const releaseCandidatePassport = readJson(
    releaseCandidatePassportPath,
    'release-candidate passport',
  );
  const acceptedSources = releaseCandidateSources(releaseCandidatePassport);
  const releasePassportRoot = qualificationContentRoot(
    releaseCandidatePassport,
  );
  const requiredPlatforms = new Set(
    expectedPlatforms || Object.keys(contract.currentClaims || {}),
  );
  const bundleRoots = fs
    .readdirSync(payloadRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(payloadRoot, entry.name))
    .sort((left, right) => left.localeCompare(right));
  const admitted = bundleRoots
    .map((bundleRoot) =>
      verifyBundle({
        bundleRoot,
        evidenceFileName,
        expectedVersion,
        acceptedSources,
        releasePassportRoot,
      }),
    )
    .filter(Boolean);
  const credentialIsland = bundleRoots
    .map((bundleRoot) =>
      verifyCredentialIslandBundle({
        bundleRoot,
        expectedVersion,
        acceptedSources,
        policy: credentialPolicy,
      }),
    )
    .filter(Boolean);
  if (credentialIsland.length !== 1) {
    throw new Error(
      `upgrade publication requires exactly one authoritative macOS credential-island payload; found ${credentialIsland.length}`,
    );
  }
  const platformCounts = new Map();
  for (const item of admitted) {
    platformCounts.set(
      item.platform,
      (platformCounts.get(item.platform) || 0) + 1,
    );
  }
  for (const platform of requiredPlatforms) {
    const count = platformCounts.get(platform) || 0;
    if (count !== 1) {
      throw new Error(
        `upgrade publication requires exactly one admitted ${platform} payload; found ${count}`,
      );
    }
  }
  const unexpected = admitted.filter(
    (item) => !requiredPlatforms.has(item.platform),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `upgrade publication contains unexpected platform payloads: ${unexpected.map((item) => item.identity).join(', ')}`,
    );
  }
  return {
    payloadRoot,
    version: expectedVersion,
    releasePassportRoot,
    platforms: admitted.map((item) => item.identity).sort(),
    evidenceRefs: admitted.map((item) => item.evidenceRef).sort(),
    campaignRoots: admitted
      .flatMap((item) =>
        item.updateCampaigns.map((campaign) => campaign.campaignRoot),
      )
      .sort(),
    channelIndexRoots: [
      ...new Set(
        admitted.flatMap((item) =>
          item.updateCampaigns.map((campaign) => campaign.channelIndexRoot),
        ),
      ),
    ].sort(),
    updateCampaigns: sortUpdateCampaigns(
      admitted.flatMap((item) => item.updateCampaigns),
    ),
    manifests: admitted
      .map(({ platform, architecture, manifestPath }) => ({
        platform,
        architecture,
        manifestPath,
      }))
      .sort((left, right) =>
        `${left.platform}-${left.architecture}`.localeCompare(
          `${right.platform}-${right.architecture}`,
        ),
      ),
    credentialIsland: credentialIsland[0],
  };
}

function receiptAdmission(admission, payloadRoot) {
  return {
    releasePassportRoot: admission.releasePassportRoot,
    platforms: admission.platforms,
    evidenceRefs: admission.evidenceRefs,
    campaignRoots: admission.campaignRoots,
    channelIndexRoots: admission.channelIndexRoots,
    updateCampaigns: admission.updateCampaigns,
    manifests: admission.manifests.map((entry) => ({
      platform: entry.platform,
      architecture: entry.architecture,
      path: safeRelative(payloadRoot, entry.manifestPath, 'upgrade manifest'),
    })),
    credentialIsland: {
      platformId: admission.credentialIsland.platformId,
      runtimeSha: admission.credentialIsland.runtimeSha,
      certificateSha1: admission.credentialIsland.certificateSha1,
      notarizationIds: admission.credentialIsland.notarizationIds,
      manifestPath: safeRelative(
        payloadRoot,
        admission.credentialIsland.manifestPath,
        'credential manifest',
      ),
      evidencePath: safeRelative(
        payloadRoot,
        admission.credentialIsland.evidencePath,
        'credential evidence',
      ),
    },
  };
}

export function createUpgradePublicationAdmission({
  payloadRoot,
  releaseCandidatePassportPath,
  expectedVersion,
  expectedPlatforms,
} = {}) {
  const resolvedPayloadRoot = fs.realpathSync(payloadRoot);
  const resolvedPassportPath = fs.realpathSync(releaseCandidatePassportPath);
  const admission = verifyUpgradePublicationPayloads({
    payloadRoot: resolvedPayloadRoot,
    releaseCandidatePassportPath: resolvedPassportPath,
    expectedVersion,
    expectedPlatforms,
  });
  const passport = readJson(resolvedPassportPath, 'release-candidate passport');
  const sources = [...releaseCandidateSources(passport)].sort();
  const artifacts = candidateArtifactRoot(resolvedPayloadRoot);
  assertCandidateBundleRoles(artifacts.bundles);
  const passportByteRoot = fileRoot(resolvedPassportPath);
  const roots = {
    source: contentRoot(sources),
    tooling: toolingRoot(),
    candidate: contentRoot({
      artifactRoot: artifacts.root,
      passportRoot: passportByteRoot,
    }),
    artifact: artifacts.root,
    platform: candidatePlatformRoot(artifacts.bundles),
    campaign: contentRoot(admission.updateCampaigns),
    policy: policyRoot(),
    passport: passportByteRoot,
    credential: contentRoot({
      manifestRoot: fileRoot(admission.credentialIsland.manifestPath),
      evidenceRoot: fileRoot(admission.credentialIsland.evidencePath),
    }),
  };
  const body = {
    schema: PRODUCT_UPGRADE_PUBLICATION_ADMISSION_SCHEMA,
    status: 'admitted',
    identity: { version: expectedVersion, sources },
    roots,
    candidate: {
      bundleCount: artifacts.bundles.length,
      bundles: artifacts.bundles,
      fileCount: artifacts.files.length,
      files: artifacts.files,
    },
    admission: receiptAdmission(admission, resolvedPayloadRoot),
    claims: {
      deterministicProductAdmission: true,
      externalPublication: false,
      notarizationAuthority: false,
      publicReadback: false,
    },
  };
  return { ...body, receiptRoot: contentRoot(body) };
}

export function writeUpgradePublicationAdmission({
  outputPath,
  capsulePath,
  ...options
} = {}) {
  if (!outputPath) throw new Error('product admission output path is required');
  const resolvedOutputPath = path.resolve(outputPath);
  const resolvedCapsulePath = path.resolve(
    capsulePath ||
      path.join(
        path.dirname(resolvedOutputPath),
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
      ),
  );
  if (path.dirname(resolvedOutputPath) !== path.dirname(resolvedCapsulePath)) {
    throw new Error(
      'product admission receipt and capsule must share one directory',
    );
  }
  const receipt = createUpgradePublicationAdmission(options);
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(receipt, null, 2)}\n`);
  const capsuleBody = {
    schema: PRODUCT_UPGRADE_PUBLICATION_CAPSULE_SCHEMA,
    candidateRoot: receipt.roots.candidate,
    artifactRoot: receipt.roots.artifact,
    passportRoot: receipt.roots.passport,
    admission: {
      path: path.basename(resolvedOutputPath),
      receiptRoot: receipt.receiptRoot,
      fileRoot: fileRoot(resolvedOutputPath),
    },
  };
  const capsule = { ...capsuleBody, capsuleRoot: contentRoot(capsuleBody) };
  fs.writeFileSync(
    resolvedCapsulePath,
    `${JSON.stringify(capsule, null, 2)}\n`,
  );
  return {
    receipt,
    capsule,
    outputPath: resolvedOutputPath,
    capsulePath: resolvedCapsulePath,
  };
}

function admittedFile(payloadRoot, relativePath, label) {
  const filePath = path.resolve(payloadRoot, relativePath || '');
  safeRelative(payloadRoot, filePath, label);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${relativePath || '<empty>'}`);
  }
  if (fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`${label} is a symbolic link: ${relativePath}`);
  }
  const resolvedRelative = path.relative(
    fs.realpathSync(payloadRoot),
    fs.realpathSync(filePath),
  );
  if (resolvedRelative.startsWith('..') || path.isAbsolute(resolvedRelative)) {
    throw new Error(`${label} resolves outside its candidate root`);
  }
  return filePath;
}

export function verifyUpgradePublicationAdmission({
  payloadRoot,
  releaseCandidatePassportPath,
  expectedVersion,
  expectedSourceSha,
  receiptPath,
  capsulePath,
} = {}) {
  if (!payloadRoot || !fs.existsSync(payloadRoot)) {
    throw new Error('product admission payload root is missing');
  }
  if (
    !releaseCandidatePassportPath ||
    !fs.existsSync(releaseCandidatePassportPath)
  ) {
    throw new Error('product admission release-candidate passport is missing');
  }
  const resolvedPayloadRoot = fs.realpathSync(payloadRoot);
  const resolvedPassportPath = fs.realpathSync(releaseCandidatePassportPath);
  const resolvedReceiptPath = receiptPath
    ? fs.realpathSync(receiptPath)
    : findExactlyOne(
        resolvedPayloadRoot,
        PRODUCT_UPGRADE_PUBLICATION_ADMISSION_FILE,
        'product admission receipt',
      );
  const resolvedCapsulePath = capsulePath
    ? fs.realpathSync(capsulePath)
    : findExactlyOne(
        resolvedPayloadRoot,
        PRODUCT_UPGRADE_PUBLICATION_CAPSULE_FILE,
        'product admission capsule',
      );
  const receipt = readJson(resolvedReceiptPath, 'product admission receipt');
  if (
    receipt.schema !== PRODUCT_UPGRADE_PUBLICATION_ADMISSION_SCHEMA ||
    receipt.status !== 'admitted'
  ) {
    throw new Error('product admission receipt contract is unsupported');
  }
  const { receiptRoot, ...receiptBody } = receipt;
  if (
    exactRoot(receiptRoot, 'product admission receipt root') !==
    contentRoot(receiptBody)
  ) {
    throw new Error('product admission receipt root drift');
  }
  const capsule = readJson(resolvedCapsulePath, 'product admission capsule');
  if (capsule.schema !== PRODUCT_UPGRADE_PUBLICATION_CAPSULE_SCHEMA) {
    throw new Error('product admission capsule contract is unsupported');
  }
  const { capsuleRoot, ...capsuleBody } = capsule;
  if (
    exactRoot(capsuleRoot, 'product admission capsule root') !==
    contentRoot(capsuleBody)
  ) {
    throw new Error('product admission capsule root drift');
  }
  if (
    capsule.admission?.path !== path.basename(resolvedReceiptPath) ||
    capsule.admission?.receiptRoot !== receipt.receiptRoot ||
    capsule.admission?.fileRoot !== fileRoot(resolvedReceiptPath)
  ) {
    throw new Error('product admission receipt is not sealed by its capsule');
  }
  const artifacts = candidateArtifactRoot(resolvedPayloadRoot);
  const passportByteRoot = fileRoot(resolvedPassportPath);
  const passport = readJson(resolvedPassportPath, 'release-candidate passport');
  const sources = [...releaseCandidateSources(passport)].sort();
  const expectedCandidateRoot = contentRoot({
    artifactRoot: artifacts.root,
    passportRoot: passportByteRoot,
  });
  const currentRoots = {
    source: contentRoot(sources),
    artifact: artifacts.root,
    passport: passportByteRoot,
    candidate: expectedCandidateRoot,
    tooling: toolingRoot(),
    policy: policyRoot(),
    platform: candidatePlatformRoot(artifacts.bundles),
  };
  for (const [name, current] of Object.entries(currentRoots)) {
    if (receipt.roots?.[name] !== current) {
      throw new Error(`product admission ${name} root drift`);
    }
  }
  if (
    receipt.candidate?.bundleCount !== artifacts.bundles.length ||
    JSON.stringify(canonical(receipt.candidate?.bundles || [])) !==
      JSON.stringify(canonical(artifacts.bundles)) ||
    receipt.candidate?.fileCount !== artifacts.files.length ||
    contentRoot(receipt.candidate?.files || []) !== artifacts.root ||
    JSON.stringify(canonical(receipt.candidate?.files || [])) !==
      JSON.stringify(canonical(artifacts.files))
  ) {
    throw new Error('product admission candidate file inventory drift');
  }
  assertCandidateBundleRoles(artifacts.bundles);
  if (
    JSON.stringify(receipt.identity?.sources || []) !== JSON.stringify(sources)
  ) {
    throw new Error('product admission source inventory drift');
  }
  if (
    receipt.admission?.releasePassportRoot !==
    qualificationContentRoot(passport)
  ) {
    throw new Error('product admission release Passport semantic root drift');
  }
  if (
    capsule.artifactRoot !== artifacts.root ||
    capsule.passportRoot !== passportByteRoot ||
    capsule.candidateRoot !== expectedCandidateRoot
  ) {
    throw new Error('product admission capsule candidate root drift');
  }
  if (expectedVersion && receipt.identity?.version !== expectedVersion) {
    throw new Error(
      `product admission version is stale: expected ${expectedVersion}, got ${receipt.identity?.version || '<empty>'}`,
    );
  }
  if (
    expectedSourceSha &&
    !receipt.identity?.sources?.includes(expectedSourceSha)
  ) {
    throw new Error('product admission source is stale');
  }
  const evidenceFileName =
    loadUpgradeQualificationContract().publication?.evidenceFileName;
  if (!evidenceFileName) {
    throw new Error(
      'upgrade qualification contract has no publication evidence file name',
    );
  }
  const manifests = (receipt.admission?.manifests || []).map((entry) => {
    const manifestPath = admittedFile(
      resolvedPayloadRoot,
      entry.path,
      'admitted manifest',
    );
    const manifest = readJson(manifestPath, 'admitted upgrade manifest');
    if (
      manifest.schema !== RELEASE_MANIFEST_SCHEMA ||
      manifest.platform !== entry.platform ||
      manifest.architecture !== entry.architecture ||
      manifest.productVersion !== receipt.identity?.version ||
      !sources.includes(manifest.sourceCommit)
    ) {
      throw new Error('admitted manifest identity drift');
    }
    const bundleName = entry.path.split('/')[0];
    const bundleRoot = path.join(resolvedPayloadRoot, bundleName);
    const evidencePath = findExactlyOne(
      bundleRoot,
      evidenceFileName,
      'admitted upgrade evidence',
    );
    const evidence = readJson(evidencePath, 'admitted upgrade evidence');
    if (
      evidence.evidenceRef !== manifest.qualificationEvidenceRef ||
      evidence.platform !== manifest.platform ||
      evidence.architecture !== manifest.architecture
    ) {
      throw new Error('admitted upgrade evidence identity drift');
    }
    return {
      platform: entry.platform,
      architecture: entry.architecture,
      manifestPath,
      evidenceRef: evidence.evidenceRef,
      updateCampaigns: projectUpdateCampaigns(
        manifest.platform,
        manifest.architecture,
        evidence.campaigns || [],
      ),
      bundleName,
    };
  });
  const expectedUpgradeBundles = artifacts.bundles
    .filter((bundle) => bundle.role === 'product-upgrade')
    .map((bundle) => bundle.name)
    .sort();
  const admittedUpgradeBundles = manifests
    .map((manifest) => manifest.bundleName)
    .sort();
  if (
    JSON.stringify(admittedUpgradeBundles) !==
    JSON.stringify(expectedUpgradeBundles)
  ) {
    throw new Error('product admission manifest bundle inventory drift');
  }
  const updateCampaigns = sortUpdateCampaigns(
    manifests.flatMap((manifest) => manifest.updateCampaigns),
  );
  const campaignRoots = updateCampaigns
    .map((campaign) => campaign.campaignRoot)
    .sort();
  const channelIndexRoots = [
    ...new Set(updateCampaigns.map((campaign) => campaign.channelIndexRoot)),
  ].sort();
  const evidenceRefs = manifests.map((manifest) => manifest.evidenceRef).sort();
  const platforms = manifests
    .map((manifest) => `${manifest.platform}-${manifest.architecture}`)
    .sort();
  if (
    receipt.roots?.campaign !== contentRoot(updateCampaigns) ||
    JSON.stringify(canonical(receipt.admission?.updateCampaigns || [])) !==
      JSON.stringify(canonical(updateCampaigns)) ||
    JSON.stringify(receipt.admission?.campaignRoots || []) !==
      JSON.stringify(campaignRoots) ||
    JSON.stringify(receipt.admission?.channelIndexRoots || []) !==
      JSON.stringify(channelIndexRoots) ||
    JSON.stringify(receipt.admission?.evidenceRefs || []) !==
      JSON.stringify(evidenceRefs) ||
    JSON.stringify(receipt.admission?.platforms || []) !==
      JSON.stringify(platforms)
  ) {
    throw new Error('product admission campaign projection drift');
  }
  const credentialManifestPath = admittedFile(
    resolvedPayloadRoot,
    receipt.admission?.credentialIsland?.manifestPath,
    'admitted credential manifest',
  );
  const credentialEvidencePath = admittedFile(
    resolvedPayloadRoot,
    receipt.admission?.credentialIsland?.evidencePath,
    'admitted credential evidence',
  );
  const credentialRoot = contentRoot({
    manifestRoot: fileRoot(credentialManifestPath),
    evidenceRoot: fileRoot(credentialEvidencePath),
  });
  if (receipt.roots?.credential !== credentialRoot) {
    throw new Error('product admission credential root drift');
  }
  const credentialManifest = readJson(
    credentialManifestPath,
    'admitted credential manifest',
  );
  const credentialEvidence = readJson(
    credentialEvidencePath,
    'admitted credential evidence',
  );
  const credentialIsland = receipt.admission?.credentialIsland;
  if (
    credentialIsland?.platformId !== credentialManifest.platform?.id ||
    credentialIsland?.runtimeSha !==
      credentialEvidence.buildchain?.runtimeSha ||
    credentialIsland?.certificateSha1 !==
      credentialEvidence.identity?.certificateSha1 ||
    JSON.stringify(credentialIsland?.notarizationIds || []) !==
      JSON.stringify([
        credentialEvidence.notarization?.application?.id,
        credentialEvidence.notarization?.diskImage?.id,
      ])
  ) {
    throw new Error('product admission credential projection drift');
  }
  return {
    ...receipt.admission,
    manifests: manifests.map(({ platform, architecture, manifestPath }) => ({
      platform,
      architecture,
      manifestPath,
    })),
    version: receipt.identity.version,
    receiptRoot: receipt.receiptRoot,
    capsuleRoot: capsule.capsuleRoot,
    candidateRoot: receipt.roots.candidate,
    artifactRoot: receipt.roots.artifact,
  };
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    throw new Error(`${name} is required`);
  }
  return args[index + 1];
}

function cli() {
  const [command, ...args] = process.argv.slice(2);
  const common = {
    payloadRoot: option(args, '--payload-root'),
    releaseCandidatePassportPath: option(args, '--passport'),
    expectedVersion: option(args, '--version'),
  };
  if (command === 'write') {
    const result = writeUpgradePublicationAdmission({
      ...common,
      outputPath: option(args, '--output'),
      capsulePath: option(args, '--capsule'),
    });
    process.stdout.write(
      `${JSON.stringify({ status: 'admitted', receiptRoot: result.receipt.receiptRoot, capsuleRoot: result.capsule.capsuleRoot })}\n`,
    );
    return;
  }
  if (command === 'verify') {
    const result = verifyUpgradePublicationAdmission({
      ...common,
      receiptPath: option(args, '--receipt'),
      capsulePath: option(args, '--capsule'),
    });
    process.stdout.write(
      `${JSON.stringify({ status: 'verified', receiptRoot: result.receiptRoot, capsuleRoot: result.capsuleRoot })}\n`,
    );
    return;
  }
  throw new Error(
    'usage: upgrade-publication-admission.mjs <write|verify> --payload-root DIR --passport FILE --version VERSION --output FILE --receipt FILE --capsule FILE',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    cli();
  } catch (error) {
    process.stderr.write(
      `upgrade-publication-admission: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
