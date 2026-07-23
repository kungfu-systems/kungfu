// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { assertUpgradePublicationEligible } from '../product/scripts/upgrade-manifest.mjs';
import { loadUpgradeQualificationContract } from './upgrade-qualification.mjs';

const RELEASE_MANIFEST_SCHEMA = 'kungfu.product-upgrade.manifest/v1';
const RELEASE_CANDIDATE_CONTRACT =
  'kungfu-buildchain-release-candidate-passport';

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
  };
}
