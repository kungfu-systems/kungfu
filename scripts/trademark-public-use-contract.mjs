// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT_PATH =
  'product/release/kungfu-trademark-public-use.contract.json';
const EXACT_MARK = 'Kungfu UNGFU™';
const PRINCIPLE = 'Never Guess. Facts Unfold.';
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
const CLASS9_CORE_IDENTIFICATIONS = [
  {
    planId: 'continuity-management',
    termId: '009-5447',
    identification:
      'Downloadable computer software for monitoring and managing continuity of artificial intelligence agent work across sessions, interruptions, and handoffs',
  },
  {
    planId: 'runtime-event-ledger',
    termId: '009-506',
    identification:
      'Downloadable software for recording, storing, querying, inspecting, and replaying runtime event data and records of work performed by artificial intelligence agents',
  },
  {
    planId: 'agent-work-records',
    termId: '009-506',
    identification:
      'Downloadable software for creating, exporting, importing, and verifying electronic records of work performed by artificial intelligence agents',
  },
  {
    planId: 'workflow-management',
    termId: '009-6548',
    identification: 'Downloadable workflow management software',
  },
  {
    planId: 'software-development-tools',
    termId: '009-5399',
    identification: 'Downloadable computer software development tools',
  },
  {
    planId: 'application-programming-interface',
    termId: '009-5657',
    identification:
      'Downloadable computer software for use as an application programming interface (API)',
  },
];
const CLASS9_CONDITIONAL_IDENTIFICATIONS = [
  {
    planId: 'interactive-inspection-replay',
    termId: '009-5754',
    identification:
      'Downloadable interactive software for inspecting and replaying computer software execution and artificial intelligence agent work records',
    condition:
      'A released CLI, TUI, or GUI exposes the claimed inspection and replay capability',
  },
  {
    planId: 'first-party-software-plugins',
    termId: '009-7662',
    identification:
      'Downloadable computer software plug-ins for data integration, workflow management, software monitoring, and software development',
    condition:
      'Kungfu distributes at least one first-party downloadable KFX plug-in under the mark',
  },
];
const REQUIRED_CLASS9_EVIDENCE_FIELDS = [
  'id',
  'planId',
  'termId',
  'identification',
  'status',
  'capabilityEvidenceKind',
  'commandOrSurface',
  'publicUrl',
  'accessedAt',
  'sourceRepository',
  'sourceCommit',
  'acquisitionSurfaceId',
  'productSurfaceId',
  'deploymentOrReleaseCoordinate',
  'renderedEvidence',
];
const ALLOWED_CLASS9_EVIDENCE_KINDS = [
  'released-cli-capability',
  'released-sdk-capability',
  'released-first-party-plugin',
];
const DISALLOWED_CLASS9_EVIDENCE_KINDS = [
  'roadmap',
  'source-only',
  'test-fixture',
  'coming-soon',
  'preview',
  'staging',
];
const IMPLEMENTED_PRODUCT_SURFACES = {
  status: 'source-implemented-release-evidence-pending',
  surfaces: [
    {
      id: 'cli-version',
      kind: 'kungfu --version',
      exactMark: EXACT_MARK,
      principle: PRINCIPLE,
      sourcePaths: [
        'crates/trunk/src/product_identity.rs',
        'framework/core/src/python/kungfu/product_identity.py',
      ],
      compatibility: 'version-first-line',
      releaseEvidenceStatus: 'not-claimed',
    },
    {
      id: 'gui-about',
      kind: 'about',
      exactMark: EXACT_MARK,
      principle: PRINCIPLE,
      sourcePaths: [
        'framework/gui/src/main/product-identity.ts',
        'framework/gui/src/main/index.ts',
      ],
      compatibility: 'primary-application-name-preserved',
      releaseEvidenceStatus: 'not-claimed',
    },
  ],
};
const RELEASE_EVIDENCE_MODEL = {
  schema: 'kungfu-ungfu-release-evidence-index',
  layers: [
    {
      id: 'specimen',
      role: 'filing-oriented-acquisition-product-pair',
      primary: true,
    },
    {
      id: 'class9CapabilityTruth',
      role: 'released-capability-truth',
      primary: true,
    },
    {
      id: 'brandArchive',
      role: 'supporting-history-only',
      primary: false,
    },
  ],
  preparationCanClaimReleasedUse: false,
  counselReviewRequired: true,
};

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
function validateTrademarkContract(contract, issues) {
  const brand = object(contract.brand);
  const state = object(contract.currentState);
  const gate = object(contract.firstPublicReleaseGate);
  const implemented = object(contract.implementedProductSurfaces);
  const releaseEvidenceModel = object(contract.releaseEvidenceModel);
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
  if (brand.principle !== PRINCIPLE)
    issues.push('source principle must remain Never Guess. Facts Unfold.');
  if (brand.owner !== OWNER) issues.push('trademark owner is not exact');
  if (brand.role !== 'secondary-source-signature')
    issues.push('mark must remain a secondary source signature');
  if (brand.registrationStatusClaim !== 'none')
    issues.push('registration status must not be claimed');
  if (
    JSON.stringify(canonicalJson(implemented)) !==
    JSON.stringify(canonicalJson(IMPLEMENTED_PRODUCT_SURFACES))
  ) {
    issues.push(
      'implemented CLI and GUI product surfaces must remain exact and release-evidence pending',
    );
  }
  if (
    JSON.stringify(canonicalJson(releaseEvidenceModel)) !==
    JSON.stringify(canonicalJson(RELEASE_EVIDENCE_MODEL))
  ) {
    issues.push(
      'release evidence must keep specimen, Class 9 truth, and supporting brand history separate',
    );
  }
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
  validateClass9Contract(gate, issues);
}

function validateClass9Contract(gate, issues) {
  const class9Gate = object(gate.class9FilingReadiness);
  const class9EvidenceGate = object(class9Gate.evidence);
  if (
    class9Gate.jurisdiction !== 'US' ||
    class9Gate.internationalClass !== '009' ||
    class9Gate.filingBasisCandidate !== 'Section 1(a)' ||
    class9Gate.legalReviewRequired !== true
  ) {
    issues.push(
      'Class 9 filing readiness must remain a US Section 1(a) candidate subject to legal review',
    );
  }
  if (
    JSON.stringify(canonicalJson(array(class9Gate.coreIdentifications))) !==
      JSON.stringify(canonicalJson(CLASS9_CORE_IDENTIFICATIONS)) ||
    JSON.stringify(
      canonicalJson(array(class9Gate.conditionalIdentifications)),
    ) !== JSON.stringify(canonicalJson(CLASS9_CONDITIONAL_IDENTIFICATIONS))
  ) {
    issues.push('Class 9 identification plan changed without review');
  }
  if (
    class9EvidenceGate.allCoreClaimsRequired !== true ||
    class9EvidenceGate.conditionalClaimsRequireEvidenceWhenSelected !== true ||
    JSON.stringify(array(class9EvidenceGate.requiredFields)) !==
      JSON.stringify(REQUIRED_CLASS9_EVIDENCE_FIELDS) ||
    JSON.stringify(array(class9EvidenceGate.allowedCapabilityEvidenceKinds)) !==
      JSON.stringify(ALLOWED_CLASS9_EVIDENCE_KINDS) ||
    JSON.stringify(
      array(class9EvidenceGate.disallowedCapabilityEvidenceKinds),
    ) !== JSON.stringify(DISALLOWED_CLASS9_EVIDENCE_KINDS)
  ) {
    issues.push('Class 9 per-identification evidence policy is incomplete');
  }
}

function validateTrademarkDocumentationSurfaces(surfaces, issues) {
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
}

function validateTrademarkRuntimeSurfaces(contract, surfaces, issues) {
  const brand = object(contract.brand);
  const nativeIdentity = surfaces['crates/trunk/src/product_identity.rs'] || '';
  const pythonIdentity =
    surfaces['framework/core/src/python/kungfu/product_identity.py'] || '';
  const guiIdentity =
    surfaces['framework/gui/src/main/product-identity.ts'] || '';
  const principle = String(brand.principle || '');
  if (
    !nativeIdentity.includes(
      `pub const SECONDARY_SOURCE_SIGNATURE: &str = "${EXACT_MARK}";`,
    ) ||
    !nativeIdentity.includes(
      `pub const SOURCE_PRINCIPLE: &str = "${principle}";`,
    ) ||
    !pythonIdentity.includes(`SECONDARY_SOURCE_SIGNATURE = "${EXACT_MARK}"`) ||
    !pythonIdentity.includes(`SOURCE_PRINCIPLE = "${principle}"`) ||
    !guiIdentity.includes(`SECONDARY_SOURCE_SIGNATURE = '${EXACT_MARK}'`) ||
    !guiIdentity.includes(`SOURCE_PRINCIPLE = '${principle}'`)
  ) {
    issues.push(
      'CLI and GUI source identities must contain the exact mark and principle',
    );
  }
  const nativeCli = surfaces['crates/trunk/src/main.rs'] || '';
  const pythonCli =
    surfaces['framework/core/src/python/kungfu/cli/commands/__init__.py'] || '';
  if (
    !nativeCli.includes('product_identity::version_banner(&version)') ||
    !pythonCli.includes('message=version_banner(kungfu.__version__)')
  ) {
    issues.push(
      'native and Python kungfu --version paths must project the product identity banner',
    );
  }
  const guiMain = surfaces['framework/gui/src/main/index.ts'] || '';
  if (
    !guiMain.includes(
      'app.setAboutPanelOptions(productAboutPanelOptions(app.getVersion()))',
    ) ||
    !guiMain.includes('app.showAboutPanel()') ||
    !guiMain.includes('versionFirstLine(out.toString())')
  ) {
    issues.push(
      'packaged GUI About and version reader must preserve the product identity contract',
    );
  }
  const installedQualification =
    surfaces['product/scripts/cli-surface-qualification.mjs'] || '';
  if (
    !installedQualification.includes(EXACT_MARK) ||
    !installedQualification.includes(principle) ||
    !installedQualification.includes('versionLines.slice(1).join')
  ) {
    issues.push(
      'installed-product qualification must require the signature after the compatible version line',
    );
  }
}

function validateTrademarkPackageSurfaces(surfaces, issues) {
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
      surfaces['framework/storage/python/pyproject.toml'] || '',
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
}

function validateTrademarkClaims(surfaces, issues) {
  for (const [surfacePath, source] of Object.entries(surfaces)) {
    if (source.includes('®'))
      issues.push(`${surfacePath} uses the registered symbol`);
    if (/\b(?:is|are) (?:an? )?registered trademark\b/iu.test(source)) {
      issues.push(`${surfacePath} makes an unsupported registration claim`);
    }
  }
}

function releasedTrademarkContext(contract, issues) {
  const state = object(contract.currentState);
  const gate = object(contract.firstPublicReleaseGate);
  const acquisitionGate = object(gate.acquisitionSurface);
  const productGate = object(gate.productSurface);
  const evidenceGate = object(gate.evidence);
  const class9Gate = object(gate.class9FilingReadiness);
  const class9EvidenceGate = object(class9Gate.evidence);
  const releasedClaim = state.releasedSoftwareUseClaim === true;
  const releaseAvailable = state.publicReleaseArtifactsAvailable === true;
  const class9Evidence = array(state.class9GoodsEvidence).map(object);
  if (releasedClaim !== releaseAvailable) {
    issues.push(
      'released-software claim and public artifact availability must change together',
    );
  }
  if (!releasedClaim && class9Evidence.length > 0) {
    issues.push(
      'pre-release state must not carry speculative Class 9 goods evidence',
    );
  }
  if (!releasedClaim) return null;
  return {
    state,
    acquisitionGate,
    productGate,
    evidenceGate,
    class9EvidenceGate,
    class9Evidence,
  };
}

function qualifyingReleaseSurfaces(context, issues) {
  const acquisitions = array(context.state.acquisitionSurfaces).map(object);
  const products = array(context.state.productSurfaces).map(object);
  const allowedAcquisitionKinds = new Set(
    array(context.acquisitionGate.allowedKinds),
  );
  const allowedProductKinds = new Set(array(context.productGate.allowedKinds));
  const disallowedEvidenceKinds = new Set(
    array(context.evidenceGate.disallowedKinds),
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
  if (qualifyingAcquisitions.length === 0)
    issues.push(
      'released use requires an exact-mark real public acquisition surface',
    );
  const qualifyingProducts = products.filter(
    (item) =>
      typeof item.id === 'string' &&
      item.id.length > 0 &&
      allowedProductKinds.has(item.kind) &&
      item.exactMark === EXACT_MARK &&
      typeof item.deploymentOrReleaseCoordinate === 'string' &&
      item.deploymentOrReleaseCoordinate.length > 0,
  );
  if (qualifyingProducts.length === 0)
    issues.push('released use requires an exact-mark stable product surface');
  return {
    qualifyingAcquisitions,
    qualifyingProducts,
    disallowedEvidenceKinds,
  };
}

function validateReleaseRecords(context, surfaces, issues) {
  const evidence = array(context.state.evidenceRecords).map(object);
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
      surfaces.disallowedEvidenceKinds.has(item.kind)
    )
      return false;
    const acquisition = surfaces.qualifyingAcquisitions.find(
      (surface) => surface.id === item.acquisitionSurfaceId,
    );
    const product = surfaces.qualifyingProducts.find(
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
  if (completeEvidence.length === 0)
    issues.push(
      'released use requires one complete public-safe evidence record bound to the acquisition and product surfaces',
    );
}

function validClass9Evidence(item, plan, context, surfaces, policy) {
  const acquisition = surfaces.qualifyingAcquisitions.find(
    (surface) => surface.id === item.acquisitionSurfaceId,
  );
  const product = surfaces.qualifyingProducts.find(
    (surface) => surface.id === item.productSurfaceId,
  );
  return (
    item.termId === plan.termId &&
    item.identification === plan.identification &&
    item.status === 'released' &&
    policy.allowed.has(item.capabilityEvidenceKind) &&
    !policy.disallowed.has(item.capabilityEvidenceKind) &&
    publicUrl(item.publicUrl) &&
    publicUrl(item.renderedEvidence) &&
    !preparatoryUrl(item.publicUrl) &&
    !preparatoryUrl(item.renderedEvidence) &&
    dateOnly(item.accessedAt) &&
    item.sourceRepository === SOURCE_REPOSITORY &&
    /^[0-9a-f]{40}$/u.test(String(item.sourceCommit)) &&
    acquisition?.deploymentOrReleaseCoordinate ===
      item.deploymentOrReleaseCoordinate &&
    product?.deploymentOrReleaseCoordinate ===
      item.deploymentOrReleaseCoordinate
  );
}

function validateClass9ReleaseEvidence(context, surfaces, issues) {
  const plans = [
    ...CLASS9_CORE_IDENTIFICATIONS,
    ...CLASS9_CONDITIONAL_IDENTIFICATIONS,
  ];
  const planById = new Map(plans.map((plan) => [plan.planId, plan]));
  const policy = {
    allowed: new Set(
      array(context.class9EvidenceGate.allowedCapabilityEvidenceKinds),
    ),
    disallowed: new Set(
      array(context.class9EvidenceGate.disallowedCapabilityEvidenceKinds),
    ),
  };
  const seenPlanIds = new Set();
  const qualifying = context.class9Evidence.filter((item) => {
    const plan = planById.get(String(item.planId));
    const complete = REQUIRED_CLASS9_EVIDENCE_FIELDS.every(
      (field) => typeof item[field] === 'string' && item[field].length > 0,
    );
    if (!plan || !complete || seenPlanIds.has(String(item.planId)))
      return false;
    seenPlanIds.add(String(item.planId));
    return validClass9Evidence(item, plan, context, surfaces, policy);
  });
  const qualifyingPlanIds = new Set(qualifying.map((item) => item.planId));
  const missingCorePlans = CLASS9_CORE_IDENTIFICATIONS.filter(
    (plan) => !qualifyingPlanIds.has(plan.planId),
  ).map((plan) => plan.planId);
  if (missingCorePlans.length > 0)
    issues.push(
      `released use requires public capability evidence for every core Class 9 identification: ${missingCorePlans.join(', ')}`,
    );
  if (qualifying.length !== context.class9Evidence.length)
    issues.push(
      'every selected Class 9 identification must carry complete released-product evidence for the exact release',
    );
}

function validateReleasedTrademarkEvidence(contract, issues) {
  const context = releasedTrademarkContext(contract, issues);
  if (!context) return;
  const surfaces = qualifyingReleaseSurfaces(context, issues);
  validateReleaseRecords(context, surfaces, issues);
  validateClass9ReleaseEvidence(context, surfaces, issues);
}

export function validateTrademarkPublicUse(contract, surfaces) {
  const issues = [];
  validateTrademarkContract(contract, issues);
  validateTrademarkDocumentationSurfaces(surfaces, issues);
  validateTrademarkRuntimeSurfaces(contract, surfaces, issues);
  validateTrademarkPackageSurfaces(surfaces, issues);
  validateTrademarkClaims(surfaces, issues);
  validateReleasedTrademarkEvidence(contract, issues);
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
        'framework/storage/python/pyproject.toml',
        'crates/trunk/src/product_identity.rs',
        'crates/trunk/src/main.rs',
        'framework/core/src/python/kungfu/product_identity.py',
        'framework/core/src/python/kungfu/cli/commands/__init__.py',
        'framework/gui/src/main/product-identity.ts',
        'framework/gui/src/main/index.ts',
        'product/scripts/cli-surface-qualification.mjs',
      ].map((item) => [item, read(item)]),
    ),
  };
}

export { CONTRACT_PATH, EXACT_MARK };
