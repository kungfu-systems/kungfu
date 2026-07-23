// SPDX-License-Identifier: Apache-2.0

import { verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = 'framework/upgrade/kungfu-upgrade-qualification.contract.json';
const UPGRADE_CONTRACT = 'framework/upgrade/kungfu-upgrade.contract.json';

export class UpgradeQualificationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

export function loadUpgradeQualificationContract(root = ROOT) {
  return readJson(root, CONTRACT);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function fail(code, message) {
  throw new UpgradeQualificationError(code, message);
}

function headings(markdown) {
  return new Set(
    markdown
      .split('\n')
      .filter((line) => /^#{1,6} /.test(line))
      .map((line) =>
        line
          .replace(/^#{1,6} /, '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9 -]/g, '')
          .replace(/\s+/g, '-'),
      ),
  );
}

export function artifactSignatureStatement(manifest, artifact, evidenceRef) {
  return Buffer.from(
    JSON.stringify(
      canonical({
        schema: 'kungfu.product-upgrade.artifact-signature/v1',
        evidenceRef,
        sourceCommit: manifest.sourceCommit,
        productVersion: manifest.productVersion,
        platform: manifest.platform,
        architecture: manifest.architecture,
        kind: artifact.kind,
        url: artifact.url,
        size: artifact.size,
        digest: artifact.digest,
      }),
    ),
  );
}

export function verifyUpgradeQualificationEvidence(
  manifest,
  evidence,
  requiredSurface,
  contract,
) {
  if (!evidence)
    fail(
      'qualification-evidence-missing',
      'qualification evidence is required',
    );
  if (evidence.schema !== contract.evidenceSchema)
    fail(
      'qualification-evidence-schema',
      'qualification evidence schema is unsupported',
    );
  if (evidence.evidenceRef !== manifest.qualificationEvidenceRef)
    fail(
      'qualification-evidence-ref',
      'qualification evidence reference does not match the manifest',
    );
  for (const field of [
    'sourceCommit',
    'productVersion',
    'platform',
    'architecture',
  ]) {
    if (evidence[field] !== manifest[field])
      fail(
        'qualification-source-mismatch',
        `qualification ${field} does not match the manifest`,
      );
  }
  if (evidence.tier !== contract.promotionTier)
    fail(
      'qualification-tier-insufficient',
      'native packaged evidence is required for promotion',
    );
  const surfaces = new Set(evidence.surfaces || []);
  for (const surface of [
    ...contract.requiredArtifactSurfaces,
    requiredSurface,
  ]) {
    if (!surfaces.has(surface))
      fail(
        'qualification-surface-missing',
        `qualification evidence has no ${surface} surface`,
      );
  }
  if (
    !Number.isInteger(evidence.runtimeChurnIterations) ||
    evidence.runtimeChurnIterations < contract.minimumRuntimeChurnIterations
  )
    fail(
      'qualification-churn-insufficient',
      'runtime churn evidence is below the release minimum',
    );
  for (const check of contract.requiredChecks) {
    if (evidence.checks?.[check] !== true)
      fail(
        'qualification-check-failed',
        `qualification check did not pass: ${check}`,
      );
  }
  const rows = new Map(
    (evidence.artifacts || []).map((row) => [row.kind, row]),
  );
  for (const artifact of manifest.artifacts || []) {
    const row = rows.get(artifact.kind);
    if (!row)
      fail(
        'qualification-signature-missing',
        `no retained signature evidence for ${artifact.kind}`,
      );
    if (
      row.digest !== artifact.digest ||
      row.size !== artifact.size ||
      row.signatureEvidenceRef !== artifact.signature
    )
      fail(
        'qualification-artifact-mismatch',
        `retained evidence does not bind ${artifact.kind}`,
      );
    if (row.algorithm !== 'ed25519' || !row.publicKeyPem || !row.signature)
      fail(
        'qualification-signature-missing',
        `incomplete Ed25519 evidence for ${artifact.kind}`,
      );
    let valid = false;
    try {
      valid = verify(
        null,
        artifactSignatureStatement(manifest, artifact, evidence.evidenceRef),
        row.publicKeyPem,
        Buffer.from(row.signature, 'base64'),
      );
    } catch {
      valid = false;
    }
    if (!valid)
      fail(
        'qualification-signature-invalid',
        `cryptographic signature verification failed for ${artifact.kind}`,
      );
  }
  return evidence;
}

export function checkUpgradeQualification(root = ROOT) {
  const contract = loadUpgradeQualificationContract(root);
  if (contract.schema !== 'kungfu.product-upgrade.qualification-contract/v1')
    throw new Error('upgrade qualification contract schema is unsupported');
  if (contract.minimumRuntimeChurnIterations < 100)
    throw new Error('upgrade qualification churn minimum must be at least 100');
  if (contract.promotionTier !== 'native-packaged')
    throw new Error('upgrade promotion must require native packaged evidence');
  for (const required of [
    'runtimeControlPlane',
    'distributionAdapters',
    'downgradeRefusal',
    'messageRegistry',
    'manualAnchors',
    'signatureVerification',
  ]) {
    if (!contract.requiredChecks.includes(required))
      throw new Error(`upgrade qualification must require ${required}`);
  }
  if (
    contract.publication?.evidenceFileName !==
    'kungfu-upgrade-qualification-evidence.json'
  )
    throw new Error(
      'upgrade publication evidence must use the retained canonical file name',
    );
  for (const platform of ['darwin', 'linux', 'win32']) {
    const claim = contract.currentClaims?.[platform];
    if (!claim || claim.promotionEligible !== false || !claim.blocker)
      throw new Error(`unqualified ${platform} claim must remain fail-closed`);
  }
  const upgrade = readJson(root, UPGRADE_CONTRACT);
  const guide = fs.readFileSync(
    path.join(root, contract.documentation.guide),
    'utf8',
  );
  const anchors = headings(guide);
  for (const [reason, message] of Object.entries(
    upgrade.messageRegistry.reasonMessages,
  )) {
    const anchor = String(message.documentationAnchor || '').replace(/^#/, '');
    if (!anchor || !anchors.has(anchor))
      throw new Error(
        `upgrade message ${reason} points to a missing guide anchor`,
      );
  }
  const fixtures = readJson(root, contract.fixtureFile);
  if (fixtures.schema !== 'kungfu.product-upgrade.qualification-fixtures/v1')
    throw new Error('upgrade qualification fixture schema is unsupported');
  if (!fixtures.cases.some((item) => item.admitted === true))
    throw new Error('upgrade qualification fixtures need an admitted control');
  for (const item of fixtures.cases) {
    if (!item.admitted && !item.code)
      throw new Error(
        `negative upgrade qualification fixture has no code: ${item.id}`,
      );
  }
  return {
    contract: CONTRACT,
    fixtures: fixtures.cases.length,
    messages: Object.keys(upgrade.messageRegistry.reasonMessages).length,
    platforms: Object.keys(contract.currentClaims).length,
  };
}
