// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertUpgradePublicationEligible } from '../product/scripts/upgrade-manifest.mjs';
import { loadUpgradeQualificationContract } from './upgrade-qualification.mjs';

const RELEASE_MANIFEST_SCHEMA = 'kungfu.product-upgrade.manifest/v1';
const RELEASE_CANDIDATE_CONTRACT =
  'kungfu-buildchain-release-candidate-passport';
const CREDENTIAL_POLICY_PATH =
  'docs/qualification/gates/macos-credential-island-policy.json';
const CREDENTIAL_EVIDENCE_FILE = 'credential-island-evidence.json';
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

function sha256File(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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

function verifyBundle({
  bundleRoot,
  evidenceFileName,
  expectedVersion,
  acceptedSources,
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
  assertUpgradePublicationEligible(manifest, 'desktop', evidence);
  assertUpgradePublicationEligible(manifest, 'cli', evidence);
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
  const acceptedSources = releaseCandidateSources(
    readJson(releaseCandidatePassportPath, 'release-candidate passport'),
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
    platforms: admitted.map((item) => item.identity).sort(),
    evidenceRefs: admitted.map((item) => item.evidenceRef).sort(),
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
