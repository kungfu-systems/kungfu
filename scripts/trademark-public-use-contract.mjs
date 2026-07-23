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
const SOURCE_REPOSITORY = 'https://github.com/kungfu-systems/kungfu';
const PROTECTED_TECHNICAL_IDENTIFIERS = {
  repository: 'kungfu-systems/kungfu',
  cli: 'kungfu',
  npmScope: '@kungfu-tech/',
  npmPackages: [
    '@kungfu-tech/workspaces',
    '@kungfu-tech/product-kungfu',
    '@kungfu-tech/core',
  ],
  pythonPackages: ['kungfu', 'kungfu-storage'],
  productDomain: 'kungfu.tech',
  developerDomain: 'libkungfu.dev',
  protocol: 'KFD',
  releaseSystem: 'Buildchain',
  localRuntime: 'libkungfu',
};
const REQUIRED_EVIDENCE_FIELDS = [
  'acquisitionSurfaceId',
  'productSurfaceId',
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
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      host !== 'localhost' &&
      host !== '127.0.0.1' &&
      host !== '::1' &&
      !host.endsWith('.local') &&
      !host.endsWith('.internal') &&
      !/^10\./u.test(host) &&
      !/^192\.168\./u.test(host) &&
      !/^172\.(?:1[6-9]|2\d|3[01])\./u.test(host)
    );
  } catch {
    return false;
  }
}

/** @param {unknown} value */
function preparatoryUrl(value) {
  if (!publicUrl(value)) return true;
  const labels = new URL(String(value)).hostname.toLowerCase().split('.');
  return labels.some(
    (label) =>
      label === 'preview' ||
      label === 'staging' ||
      label === 'stage' ||
      /^pr-\d+$/u.test(label),
  );
}

/** @param {unknown} value */
function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJson(item)]),
    );
  }
  return value;
}

/** @param {unknown} value */
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value &&
    value <= new Date().toISOString().slice(0, 10)
  );
}

/** @param {string} source @param {string} expected */
function tomlProjectName(source, expected) {
  const marker = /^\[project\]\s*$/mu.exec(source);
  if (!marker) return false;
  const rest = source.slice(marker.index + marker[0].length);
  const nextSection = rest.search(/\n\[/u);
  const project = nextSection < 0 ? rest : rest.slice(0, nextSection);
  return project.match(/^name\s*=\s*"([^"]+)"\s*$/mu)?.[1] === expected;
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
  const identifiers = object(brand.protectedTechnicalIdentifiers);
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
  if (
    JSON.stringify(canonicalJson(identifiers)) !==
    JSON.stringify(canonicalJson(PROTECTED_TECHNICAL_IDENTIFIERS))
  ) {
    issues.push(
      'repository, CLI, package, domain, KFD, Buildchain, and libkungfu identifiers must not be renamed',
    );
  }
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
  const rootPackage = JSON.parse(surfaces['package.json'] || '{}');
  const productPackage = JSON.parse(surfaces['product/package.json'] || '{}');
  const corePackage = JSON.parse(
    surfaces['framework/core/package.json'] || '{}',
  );
  const canonicalRepository = `${SOURCE_REPOSITORY}.git`;
  if (
    rootPackage.name !== PROTECTED_TECHNICAL_IDENTIFIERS.npmPackages[0] ||
    productPackage.name !== PROTECTED_TECHNICAL_IDENTIFIERS.npmPackages[1] ||
    corePackage.name !== PROTECTED_TECHNICAL_IDENTIFIERS.npmPackages[2] ||
    rootPackage.homepage !==
      `https://${PROTECTED_TECHNICAL_IDENTIFIERS.productDomain}` ||
    productPackage.homepage !==
      `https://${PROTECTED_TECHNICAL_IDENTIFIERS.productDomain}` ||
    productPackage.repository?.url !== canonicalRepository ||
    corePackage.repository?.url !== canonicalRepository ||
    corePackage.bin?.kungfu !== 'lib/kungfu-cli.js' ||
    typeof rootPackage.scripts?.kungfu !== 'string' ||
    !rootPackage.scripts.kungfu.includes(
      PROTECTED_TECHNICAL_IDENTIFIERS.npmPackages[2],
    )
  ) {
    issues.push('canonical npm package, domain, or kungfu CLI binding changed');
  }
  if (
    !tomlProjectName(
      surfaces['framework/core/pyproject.toml'] || '',
      PROTECTED_TECHNICAL_IDENTIFIERS.pythonPackages[0],
    ) ||
    !tomlProjectName(
      surfaces['framework/sdk/python/pyproject.toml'] || '',
      PROTECTED_TECHNICAL_IDENTIFIERS.pythonPackages[1],
    )
  ) {
    issues.push('canonical Python package identity changed');
  }
  const readme = surfaces['README.md'] || '';
  const requiredPublicIdentifiers = [
    `https://github.com/${PROTECTED_TECHNICAL_IDENTIFIERS.repository}`,
    `https://${PROTECTED_TECHNICAL_IDENTIFIERS.productDomain}`,
    `https://${PROTECTED_TECHNICAL_IDENTIFIERS.developerDomain}`,
    PROTECTED_TECHNICAL_IDENTIFIERS.protocol,
    PROTECTED_TECHNICAL_IDENTIFIERS.releaseSystem,
    PROTECTED_TECHNICAL_IDENTIFIERS.localRuntime,
  ];
  if (
    requiredPublicIdentifiers.some((identifier) => !readme.includes(identifier))
  ) {
    issues.push(
      'canonical repository, domain, KFD, Buildchain, or libkungfu identity changed',
    );
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

    const qualifyingAcquisitions = acquisitions.filter(
      (item) =>
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        allowedAcquisitionKinds.has(item.kind) &&
        item.exactMark === EXACT_MARK &&
        publicUrl(item.publicUrl) &&
        !preparatoryUrl(item.publicUrl) &&
        typeof item.deploymentOrReleaseCoordinate === 'string' &&
        item.deploymentOrReleaseCoordinate.length > 0 &&
        !disallowedEvidenceKinds.has(item.evidenceKind),
    );
    if (qualifyingAcquisitions.length === 0) {
      issues.push(
        'released use requires an exact-mark real public acquisition surface',
      );
    }
    const qualifyingProducts = products.filter(
      (item) =>
        typeof item.id === 'string' &&
        item.id.length > 0 &&
        allowedProductKinds.has(item.kind) &&
        item.exactMark === EXACT_MARK &&
        typeof item.deploymentOrReleaseCoordinate === 'string' &&
        item.deploymentOrReleaseCoordinate.length > 0,
    );
    if (qualifyingProducts.length === 0) {
      issues.push('released use requires an exact-mark stable product surface');
    }
    const completeEvidence = evidence.filter((item) => {
      if (
        !REQUIRED_EVIDENCE_FIELDS.every(
          (field) => typeof item[field] === 'string' && item[field].length > 0,
        ) ||
        !publicUrl(item.publicUrl) ||
        !publicUrl(item.renderedEvidence) ||
        preparatoryUrl(item.publicUrl) ||
        preparatoryUrl(item.renderedEvidence) ||
        !dateOnly(item.accessedAt) ||
        item.sourceRepository !== SOURCE_REPOSITORY ||
        !/^[0-9a-f]{40}$/u.test(String(item.sourceCommit)) ||
        disallowedEvidenceKinds.has(item.kind)
      ) {
        return false;
      }
      const acquisition = qualifyingAcquisitions.find(
        (surface) => surface.id === item.acquisitionSurfaceId,
      );
      const product = qualifyingProducts.find(
        (surface) => surface.id === item.productSurfaceId,
      );
      return (
        acquisition?.publicUrl === item.publicUrl &&
        acquisition?.deploymentOrReleaseCoordinate ===
          item.deploymentOrReleaseCoordinate &&
        product?.deploymentOrReleaseCoordinate ===
          item.deploymentOrReleaseCoordinate
      );
    });
    if (completeEvidence.length === 0) {
      issues.push(
        'released use requires one complete public-safe evidence record bound to the acquisition and product surfaces',
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
      [
        'README.md',
        'TRADEMARK.md',
        'docs/concepts/why-kungfu.md',
        'package.json',
        'product/package.json',
        'framework/core/package.json',
        'framework/core/pyproject.toml',
        'framework/sdk/python/pyproject.toml',
      ].map((item) => [item, read(item)]),
    ),
  };
}

export { CONTRACT_PATH, EXACT_MARK };
