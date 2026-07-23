// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH =
  'framework/release/kungfu-trademark-public-use.contract.json';
const EXACT_MARK = 'Kungfu UNGFU™';
const OWNER = 'Kungfu Origin Technology Limited';
const REQUIRED_EVIDENCE_FIELDS = [
  'publicUrl',
  'accessedAt',
  'sourceRepository',
  'sourceCommit',
  'deploymentOrReleaseCoordinate',
  'renderedEvidence',
];

/** @param {unknown} value */
function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

/** @param {unknown} value */
function array(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {unknown} value */
function publicUrl(value) {
  return typeof value === 'string' && /^https:\/\//u.test(value);
}

/**
 * @param {Record<string, unknown>} contract
 * @param {Record<string, string>} surfaces
 */
export function validateTrademarkPublicUse(contract, surfaces) {
  const issues = [];
  const brand = object(contract.brand);
  const state = object(contract.currentState);
  const gate = object(contract.firstPublicReleaseGate);
  const acquisitionGate = object(gate.acquisitionSurface);
  const productGate = object(gate.productSurface);
  const evidenceGate = object(gate.evidence);

  if (contract.schema !== 'kungfu.trademark-public-use/v1')
    issues.push('schema must remain v1');
  if (brand.primaryProductName !== 'Kungfu')
    issues.push('primary product name must remain Kungfu');
  if (brand.exactMark !== EXACT_MARK)
    issues.push('exact mark must remain Kungfu UNGFU™');
  if (brand.owner !== OWNER) issues.push('trademark owner is not exact');
  if (brand.role !== 'secondary-source-signature')
    issues.push('mark must remain a secondary source signature');
  if (brand.registrationStatusClaim !== 'none')
    issues.push('registration status must not be claimed');
  if (state.firstUseDateClaim !== null)
    issues.push('the gate must not infer or backdate first use');
  if (state.legalConclusion !== 'not-made')
    issues.push('the contract must not make a legal conclusion');
  if (
    acquisitionGate.minimum !== 1 ||
    acquisitionGate.exactMarkRequired !== true
  ) {
    issues.push('a real acquisition surface with the exact mark is required');
  }
  if (productGate.minimum !== 1 || productGate.exactMarkRequired !== true) {
    issues.push('a stable product surface with the exact mark is required');
  }
  if (
    evidenceGate.publicOnly !== true ||
    evidenceGate.backdatingAllowed !== false
  ) {
    issues.push('evidence must remain public-only and non-backdated');
  }
  if (
    JSON.stringify(array(evidenceGate.requiredFields)) !==
    JSON.stringify(REQUIRED_EVIDENCE_FIELDS)
  ) {
    issues.push('public evidence coordinates are incomplete');
  }

  const firstScreen = (surfaces['README.md'] || '').slice(0, 2400);
  if (
    !firstScreen.includes(EXACT_MARK) ||
    !firstScreen.includes('docs/concepts/why-kungfu.md')
  ) {
    issues.push(
      'README first screen must show the exact mark and stable Why Kungfu link',
    );
  }
  const policy = surfaces['TRADEMARK.md'] || '';
  if (!policy.includes(`${EXACT_MARK}** is a trademark of ${OWNER}`)) {
    issues.push('TRADEMARK.md must state the exact mark and owner');
  }
  if (
    !policy.includes('Apache-2.0') ||
    !policy.includes('does not grant trademark rights')
  ) {
    issues.push('TRADEMARK.md must separate trademark rights from Apache-2.0');
  }
  const why = surfaces['docs/concepts/why-kungfu.md'] || '';
  if (
    !why.includes(EXACT_MARK) ||
    !why.includes('UNGFU is not a second product or runtime')
  ) {
    issues.push('Why Kungfu must preserve the exact mark and product boundary');
  }

  for (const [surfacePath, source] of Object.entries(surfaces)) {
    if (source.includes('®'))
      issues.push(`${surfacePath} uses the registered symbol`);
    if (/\b(?:is|are) (?:an? )?registered trademark\b/iu.test(source)) {
      issues.push(`${surfacePath} makes an unsupported registration claim`);
    }
  }

  const releasedClaim = state.releasedSoftwareUseClaim === true;
  const releaseAvailable = state.publicReleaseArtifactsAvailable === true;
  if (releasedClaim !== releaseAvailable) {
    issues.push(
      'released-software claim and public artifact availability must change together',
    );
  }
  if (releasedClaim) {
    const acquisitions = array(state.acquisitionSurfaces).map(object);
    const products = array(state.productSurfaces).map(object);
    const evidence = array(state.evidenceRecords).map(object);
    const allowedAcquisitionKinds = new Set(
      array(acquisitionGate.allowedKinds),
    );
    const allowedProductKinds = new Set(array(productGate.allowedKinds));
    const disallowedEvidenceKinds = new Set(
      array(evidenceGate.disallowedKinds),
    );

    if (
      !acquisitions.some(
        (item) =>
          allowedAcquisitionKinds.has(item.kind) &&
          item.exactMark === EXACT_MARK &&
          publicUrl(item.publicUrl) &&
          !disallowedEvidenceKinds.has(item.evidenceKind),
      )
    ) {
      issues.push(
        'released use requires an exact-mark real public acquisition surface',
      );
    }
    if (
      !products.some(
        (item) =>
          allowedProductKinds.has(item.kind) && item.exactMark === EXACT_MARK,
      )
    ) {
      issues.push('released use requires an exact-mark stable product surface');
    }
    if (
      !evidence.some(
        (item) =>
          REQUIRED_EVIDENCE_FIELDS.every(
            (field) =>
              typeof item[field] === 'string' && item[field].length > 0,
          ) &&
          publicUrl(item.publicUrl) &&
          !disallowedEvidenceKinds.has(item.kind),
      )
    ) {
      issues.push(
        'released use requires one complete public-safe evidence record',
      );
    }
  }
  return issues;
}

/** @param {string} [root] */
export function loadTrademarkPublicUse(root = ROOT) {
  const read = (relativePath) =>
    fs.readFileSync(path.join(root, relativePath), 'utf8');
  return {
    contract: JSON.parse(read(CONTRACT_PATH)),
    surfaces: Object.fromEntries(
      ['README.md', 'TRADEMARK.md', 'docs/concepts/why-kungfu.md'].map(
        (item) => [item, read(item)],
      ),
    ),
  };
}

export { CONTRACT_PATH, EXACT_MARK };
