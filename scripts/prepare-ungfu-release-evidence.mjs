#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXACT_MARK,
  loadTrademarkPublicUse,
  validateTrademarkPublicUse,
} from './trademark-public-use-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = 'kungfu-ungfu-release-evidence-index';
const ID = 'ungfu-public-use';
const SOURCE_REPOSITORY = 'https://github.com/kungfu-systems/kungfu';
const PRINCIPLE = 'Never Guess. Facts Unfold.';
const SOFTWARE_DESCRIPTION =
  'Downloadable software for durable AI-agent work, inspection, and development workflows.';
const RECEIPT_SET_SCHEMA =
  'kungfu-buildchain-release-activation-receipt-set/v1';
const RECEIPT_KINDS = [
  'artifact-publication',
  'release-passport',
  'site-publication',
  'public-readback',
  'product-qualification',
];

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function placeholder(value) {
  return typeof value === 'string' && /\$\{[^}]+\}|<[^>]+>/u.test(value);
}

function publicUrl(value) {
  if (!nonEmpty(value)) return false;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !['localhost', '127.0.0.1', '::1'].includes(host) &&
      !host.endsWith('.local') &&
      !host.endsWith('.internal') &&
      !/^10\.|^192\.168\.|^172\.(?:1[6-9]|2\d|3[01])\./u.test(host) &&
      !host
        .split('.')
        .some(
          (label) =>
            ['preview', 'staging', 'stage'].includes(label) ||
            /^pr-\d+$/u.test(label),
        )
    );
  } catch {
    return false;
  }
}

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value || ''))) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.valueOf()) &&
    date.toISOString().slice(0, 10) === value &&
    value <= new Date().toISOString().slice(0, 10)
  );
}

function readJson(file, label = 'JSON') {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${file}: ${error.message}`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function contentRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(stableJson(value))
    .digest('hex')}`;
}

function receiptSetRoot(value) {
  const {
    receiptSetRoot: _receiptSetRoot,
    transactionRoot: _transactionRoot,
    ...copy
  } = structuredClone(value);
  return contentRoot(copy);
}

function bindingRoot(value) {
  return contentRoot(value);
}

function loadReceiptDocuments(receiptSet, receiptSetPath) {
  const base = path.dirname(path.resolve(receiptSetPath));
  return Object.fromEntries(
    array(receiptSet.receipts).map((receipt) => {
      const locator = String(object(receipt).locator || '');
      if (!locator || /^https?:/u.test(locator)) {
        throw new Error(
          'release evidence synthesis requires retained local receipt locators',
        );
      }
      const file = path.resolve(base, locator);
      if (!file.startsWith(`${base}${path.sep}`)) {
        throw new Error('receipt locator escapes the receipt-set directory');
      }
      return [receipt.kind, readJson(file, `${receipt.kind} receipt`)];
    }),
  );
}

function assertReceiptSet(receiptSet, documents) {
  if (
    receiptSet.schema !== RECEIPT_SET_SCHEMA ||
    receiptSet.mode !== 'activation' ||
    receiptSet.releasedUseClaim !== true
  ) {
    throw new Error(
      'released evidence requires an activation-mode authoritative receipt set',
    );
  }
  if (receiptSet.receiptSetRoot !== receiptSetRoot(receiptSet)) {
    throw new Error('activation receiptSetRoot mismatch');
  }
  const bindings = object(receiptSet.bindings);
  const exactBindingRoot = bindingRoot(bindings);
  const receipts = array(receiptSet.receipts);
  if (
    receipts.map((receipt) => receipt.kind).join(',') !==
    RECEIPT_KINDS.join(',')
  ) {
    throw new Error(
      'activation receipt set must contain five canonical receipt kinds',
    );
  }
  for (const receipt of receipts) {
    const document = documents[receipt.kind];
    if (!document || contentRoot(document) !== receipt.root) {
      throw new Error(`${receipt.kind} receipt content root mismatch`);
    }
    if (receipt.bindingRoot !== exactBindingRoot) {
      throw new Error(`${receipt.kind} receipt binding root mismatch`);
    }
  }
  if (
    !/^[0-9a-f]{40}$/u.test(String(bindings.sourceSha || '')) ||
    !/^[0-9a-f]{40}$/u.test(String(bindings.siteSourceSha || '')) ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(bindings.artifactSetRoot || '')) ||
    bindings.tag !== `v${bindings.version}` ||
    !['alpha', 'release'].includes(bindings.channel) ||
    bindings.environment !== 'production'
  ) {
    throw new Error(
      'activation receipt bindings are incomplete or non-production',
    );
  }
  return bindings;
}

export function createUngfuReleaseEvidenceFromReceipts(
  receiptSet,
  documents,
  { root = ROOT } = {},
) {
  const bindings = assertReceiptSet(receiptSet, documents);
  const artifact = object(documents['artifact-publication']);
  const passport = object(documents['release-passport']);
  const site = object(documents['site-publication']);
  const readback = object(documents['public-readback']);
  const qualification = object(documents['product-qualification']);
  const roots = array(artifact.artifactRoots);
  const siteRelease = object(site.release);
  const siteAcquisition = object(site.acquisitionEvidence);
  if (
    artifact.schema !== 'kungfu.activation-artifact-publication/v1' ||
    artifact.sourceSha !== bindings.sourceSha ||
    artifact.artifactSetRoot !== bindings.artifactSetRoot ||
    roots.length === 0
  ) {
    throw new Error('artifact publication receipt does not match activation');
  }
  if (
    passport.contract !== 'kungfu-buildchain-release-passport' ||
    passport.release?.sourceSha !== bindings.sourceSha ||
    passport.release?.tag !== bindings.tag ||
    passport.release?.channel !== bindings.channel ||
    (passport.release?.publishedVersion || passport.release?.version) !==
      bindings.version ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(passport.passportRoot || ''))
  ) {
    throw new Error('Release Passport does not match activation');
  }
  if (
    site.schema !== 'kungfu.release-status/v1' ||
    site.status !== 'current-release' ||
    site.releasedUseClaim !== true ||
    siteRelease.sourceSha !== bindings.sourceSha ||
    siteRelease.siteSourceSha !== bindings.siteSourceSha ||
    siteRelease.tag !== bindings.tag ||
    siteRelease.channel !== bindings.channel ||
    siteRelease.version !== bindings.version ||
    siteRelease.releasePassport?.root !== passport.passportRoot ||
    !publicUrl(siteAcquisition.url) ||
    !/^sha256:[0-9a-f]{64}$/u.test(String(siteAcquisition.root || ''))
  ) {
    throw new Error('site publication receipt does not match activation');
  }
  if (
    readback.schema !== 'kungfu.release-public-readback/v1' ||
    readback.qualified !== true ||
    readback.sourceSha !== bindings.sourceSha ||
    readback.siteSourceSha !== bindings.siteSourceSha ||
    readback.version !== bindings.version ||
    readback.channel !== bindings.channel ||
    readback.acquisitionRoot !== siteAcquisition.root ||
    !dateOnly(readback.observedAt)
  ) {
    throw new Error('public readback receipt is stale or mismatched');
  }
  if (
    qualification.schema !== 'kungfu.cli-installed-product-qualification/v1' ||
    qualification.qualified !== true ||
    qualification.version !== bindings.version ||
    qualification.sourceSha !== bindings.sourceSha ||
    qualification.productIdentity?.exactMark !== EXACT_MARK ||
    qualification.productIdentity?.principle !== PRINCIPLE ||
    qualification.checks?.releaseCapability?.passed !== true
  ) {
    throw new Error(
      'installed product qualification does not match activation',
    );
  }
  const archiveRoot = `sha256:${qualification.identity?.archiveSha256 || ''}`;
  if (!roots.some((item) => object(item).sha256 === archiveRoot)) {
    throw new Error(
      'installed product qualification archive root is not an artifact receipt root',
    );
  }
  const deploymentCoordinate = `github-release:kungfu-systems/kungfu@${bindings.tag}`;
  const acquisition = {
    id: 'install-page',
    kind: 'public-release-download',
    exactMark: EXACT_MARK,
    softwareDescription: SOFTWARE_DESCRIPTION,
    publicUrl: readback.acquisition.publicUrl,
    acquisitionUrl: readback.acquisition.acquisitionUrl,
    accessedAt: readback.observedAt,
    sourceCommit: bindings.sourceSha,
    deploymentOrReleaseCoordinate: deploymentCoordinate,
    renderedEvidence: readback.acquisition.renderedEvidence,
  };
  const product = {
    id: 'cli-version',
    kind: 'kungfu --version',
    exactMark: EXACT_MARK,
    publicUrl: readback.product.publicUrl,
    accessedAt: readback.observedAt,
    sourceCommit: bindings.sourceSha,
    deploymentOrReleaseCoordinate: deploymentCoordinate,
    renderedEvidence: readback.product.renderedEvidence,
  };
  const plans =
    loadTrademarkPublicUse(root).contract.firstPublicReleaseGate
      .class9FilingReadiness.coreIdentifications;
  return {
    schemaVersion: 1,
    contract: CONTRACT,
    id: ID,
    kind: 'public-acquisition-and-capability-evidence',
    state: 'released-observation',
    release: {
      sourceSha: bindings.sourceSha,
      siteSourceSha: bindings.siteSourceSha,
      tag: bindings.tag,
      channel: bindings.channel,
      version: bindings.version,
      deploymentCoordinate,
      artifactSetRoot: bindings.artifactSetRoot,
      releasePassportRoot: passport.passportRoot,
      activationReceiptSetRoot: receiptSet.receiptSetRoot,
      artifactRoots: roots.map(({ name, sha256 }) => ({ name, sha256 })),
    },
    layers: {
      specimen: {
        role: 'filing-oriented-acquisition-product-pair',
        acquisition,
        product,
        records: [
          {
            kind: 'release',
            acquisitionSurfaceId: acquisition.id,
            productSurfaceId: product.id,
            publicUrl: acquisition.publicUrl,
            accessedAt: readback.observedAt,
            sourceRepository: SOURCE_REPOSITORY,
            sourceCommit: bindings.sourceSha,
            deploymentOrReleaseCoordinate: deploymentCoordinate,
            renderedEvidence: acquisition.renderedEvidence,
          },
        ],
      },
      class9CapabilityTruth: {
        role: 'released-capability-truth',
        records: plans.map((plan) => ({
          id: `class9-${plan.planId}`,
          planId: plan.planId,
          termId: plan.termId,
          identification: plan.identification,
          status: 'released',
          capabilityEvidenceKind:
            plan.planId === 'application-programming-interface'
              ? 'released-sdk-capability'
              : 'released-cli-capability',
          commandOrSurface: `kungfu qualification ${plan.planId}`,
          qualificationCheck: 'checks.releaseCapability.passed',
          publicUrl: product.publicUrl,
          accessedAt: readback.observedAt,
          sourceRepository: SOURCE_REPOSITORY,
          sourceCommit: bindings.sourceSha,
          acquisitionSurfaceId: acquisition.id,
          productSurfaceId: product.id,
          deploymentOrReleaseCoordinate: deploymentCoordinate,
          renderedEvidence: product.renderedEvidence,
        })),
      },
      brandArchive: {
        role: 'supporting-history-only',
        primaryEvidence: false,
        records: array(readback.brandArchive),
      },
    },
    legalBoundary: {
      firstUseDateClaim: null,
      legalConclusion: 'not-made',
      registrationStatusClaim: 'none',
      counselReviewRequired: true,
    },
  };
}

function exactLegalBoundary(value) {
  const boundary = object(value);
  return (
    boundary.firstUseDateClaim === null &&
    boundary.legalConclusion === 'not-made' &&
    boundary.registrationStatusClaim === 'none' &&
    boundary.counselReviewRequired === true
  );
}

export function createUngfuEvidencePreparation({
  sourceSha = '${BUILDCHAIN_RELEASE_SOURCE_SHA}',
  tag = '${BUILDCHAIN_RELEASE_TAG}',
  channel = '${BUILDCHAIN_RELEASE_CHANNEL}',
  version = '${BUILDCHAIN_RELEASE_VERSION}',
  deploymentCoordinate = '${BUILDCHAIN_RELEASE_DEPLOYMENT_COORDINATE}',
} = {}) {
  return {
    schemaVersion: 1,
    contract: CONTRACT,
    id: ID,
    kind: 'public-acquisition-and-capability-evidence',
    state: 'preparation',
    release: {
      sourceSha,
      tag,
      channel,
      version,
      deploymentCoordinate,
      artifactRoots: [],
    },
    layers: {
      specimen: {
        role: 'filing-oriented-acquisition-product-pair',
        acquisition: null,
        product: null,
        records: [],
      },
      class9CapabilityTruth: {
        role: 'released-capability-truth',
        records: [],
      },
      brandArchive: {
        role: 'supporting-history-only',
        primaryEvidence: false,
        records: [],
      },
    },
    legalBoundary: {
      firstUseDateClaim: null,
      legalConclusion: 'not-made',
      registrationStatusClaim: 'none',
      counselReviewRequired: true,
    },
  };
}

function releasedContractProjection(index, root = ROOT) {
  const { contract, surfaces } = loadTrademarkPublicUse(root);
  const release = object(index.release);
  const specimen = object(object(index.layers).specimen);
  const acquisition = object(specimen.acquisition);
  const product = object(specimen.product);
  contract.currentState = {
    publicReleaseArtifactsAvailable: true,
    releasedSoftwareUseClaim: true,
    firstUseDateClaim: null,
    legalConclusion: 'not-made',
    acquisitionSurfaces: [
      {
        id: acquisition.id,
        kind: acquisition.kind,
        evidenceKind: 'release',
        exactMark: acquisition.exactMark,
        publicUrl: acquisition.publicUrl,
        deploymentOrReleaseCoordinate: release.deploymentCoordinate,
      },
    ],
    productSurfaces: [
      {
        id: product.id,
        kind: product.kind,
        exactMark: product.exactMark,
        deploymentOrReleaseCoordinate: release.deploymentCoordinate,
      },
    ],
    evidenceRecords: array(specimen.records),
    class9GoodsEvidence: array(
      object(object(index.layers).class9CapabilityTruth).records,
    ),
  };
  return { contract, surfaces };
}

export function validateUngfuReleaseEvidence(
  index,
  { requireReleased = false, root = ROOT } = {},
) {
  const issues = [];
  const release = object(index.release);
  const layers = object(index.layers);
  const specimen = object(layers.specimen);
  const class9 = object(layers.class9CapabilityTruth);
  const archive = object(layers.brandArchive);
  if (
    index.schemaVersion !== 1 ||
    index.contract !== CONTRACT ||
    index.id !== ID ||
    index.kind !== 'public-acquisition-and-capability-evidence'
  ) {
    issues.push('release evidence identity or schema is invalid');
  }
  if (!['preparation', 'released-observation'].includes(index.state)) {
    issues.push('state must be preparation or released-observation');
  }
  if (
    specimen.role !== 'filing-oriented-acquisition-product-pair' ||
    class9.role !== 'released-capability-truth' ||
    archive.role !== 'supporting-history-only' ||
    archive.primaryEvidence !== false
  ) {
    issues.push('the three evidence layers are incomplete or conflated');
  }
  if (!exactLegalBoundary(index.legalBoundary)) {
    issues.push(
      'release evidence must retain the no-legal-conclusion boundary',
    );
  }
  if (JSON.stringify(index).includes('®')) {
    issues.push('release evidence must not use the registered symbol');
  }
  if (index.state === 'preparation') {
    if (
      specimen.acquisition !== null ||
      specimen.product !== null ||
      array(specimen.records).length > 0 ||
      array(class9.records).length > 0
    ) {
      issues.push('preparation state must not carry released evidence');
    }
    if (requireReleased) {
      issues.push('preparation state cannot satisfy the released-use gate');
    }
    return issues;
  }
  if (requireReleased && index.state !== 'released-observation') {
    issues.push('released evidence is required');
  }
  for (const [field, value] of Object.entries({
    sourceSha: release.sourceSha,
    tag: release.tag,
    channel: release.channel,
    version: release.version,
    deploymentCoordinate: release.deploymentCoordinate,
  })) {
    if (!nonEmpty(value) || placeholder(value)) {
      issues.push(`release.${field} must be an exact observed coordinate`);
    }
  }
  if (!/^[0-9a-f]{40}$/u.test(String(release.sourceSha || ''))) {
    issues.push('release.sourceSha must be a full Git commit');
  }
  if (!/^[0-9a-f]{40}$/u.test(String(release.siteSourceSha || ''))) {
    issues.push('release.siteSourceSha must be a full Git commit');
  }
  if (release.tag !== `v${release.version}`) {
    issues.push('release tag and version must match exactly');
  }
  if (!['alpha', 'release'].includes(release.channel)) {
    issues.push('release channel must be alpha or release');
  }
  const roots = array(release.artifactRoots);
  for (const [field, value] of Object.entries({
    artifactSetRoot: release.artifactSetRoot,
    releasePassportRoot: release.releasePassportRoot,
    activationReceiptSetRoot: release.activationReceiptSetRoot,
  })) {
    if (!/^sha256:[0-9a-f]{64}$/u.test(String(value || ''))) {
      issues.push(`release.${field} must be a SHA-256 content root`);
    }
  }
  if (
    roots.length === 0 ||
    roots.some(
      (item) =>
        !nonEmpty(object(item).name) ||
        !/^sha256:[0-9a-f]{64}$/u.test(String(object(item).sha256 || '')),
    )
  ) {
    issues.push('release must include signed artifact SHA-256 roots');
  }
  const acquisition = object(specimen.acquisition);
  const product = object(specimen.product);
  if (
    acquisition.exactMark !== EXACT_MARK ||
    acquisition.softwareDescription !== SOFTWARE_DESCRIPTION ||
    !publicUrl(acquisition.publicUrl) ||
    !publicUrl(acquisition.acquisitionUrl) ||
    !publicUrl(acquisition.renderedEvidence) ||
    !dateOnly(acquisition.accessedAt)
  ) {
    issues.push(
      'acquisition evidence must bind the exact mark, software description, working public action, render, and observed date',
    );
  }
  if (
    product.exactMark !== EXACT_MARK ||
    !['kungfu --version', 'about'].includes(product.kind) ||
    !publicUrl(product.publicUrl) ||
    !publicUrl(product.renderedEvidence) ||
    !dateOnly(product.accessedAt)
  ) {
    issues.push(
      'product evidence must bind an independently readable released CLI or GUI About surface',
    );
  }
  const bindingValues = [
    acquisition.sourceCommit,
    product.sourceCommit,
    ...array(specimen.records).map((item) => object(item).sourceCommit),
    ...array(class9.records).map((item) => object(item).sourceCommit),
  ];
  if (bindingValues.some((value) => value !== release.sourceSha)) {
    issues.push('all evidence source commits must match the release');
  }
  const coordinates = [
    acquisition.deploymentOrReleaseCoordinate,
    product.deploymentOrReleaseCoordinate,
    ...array(specimen.records).map(
      (item) => object(item).deploymentOrReleaseCoordinate,
    ),
    ...array(class9.records).map(
      (item) => object(item).deploymentOrReleaseCoordinate,
    ),
  ];
  if (coordinates.some((value) => value !== release.deploymentCoordinate)) {
    issues.push('all evidence deployment coordinates must match the release');
  }
  const projection = releasedContractProjection(index, root);
  issues.push(
    ...validateTrademarkPublicUse(projection.contract, projection.surfaces),
  );
  return [...new Set(issues)];
}

async function fetchPublic(fetchImpl, url, label, { json = false } = {}) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'kungfu-ungfu-release-evidence/1' },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`${label} returned HTTP ${response.status}`);
  }
  return json ? response.json() : response.text();
}

export async function readBackUngfuReleaseEvidence(
  index,
  { fetchImpl = fetch } = {},
) {
  const release = object(index.release);
  const specimen = object(object(index.layers).specimen);
  const acquisition = object(specimen.acquisition);
  const product = object(specimen.product);
  const html = await fetchPublic(
    fetchImpl,
    acquisition.publicUrl,
    'public acquisition page',
  );
  const marker = html.match(
    /<[^>]+data-ungfu-release-acquisition[^>]*>[\s\S]*?<\/(?:section|div|article)>/iu,
  )?.[0];
  if (
    !marker ||
    !marker.includes(EXACT_MARK) ||
    !marker.includes(acquisition.softwareDescription) ||
    !marker.includes(acquisition.acquisitionUrl) ||
    !marker.includes(release.version) ||
    !marker.includes(release.channel)
  ) {
    throw new Error(
      'public acquisition page does not keep the exact mark, software description, version/channel, and acquisition action in one release block',
    );
  }
  await fetchPublic(
    fetchImpl,
    acquisition.acquisitionUrl,
    'acquisition action',
  );
  await fetchPublic(
    fetchImpl,
    acquisition.renderedEvidence,
    'rendered acquisition evidence',
  );
  const qualification = await fetchPublic(
    fetchImpl,
    product.publicUrl,
    'released product qualification',
    { json: true },
  );
  if (
    qualification.schema !== 'kungfu.cli-installed-product-qualification/v1' ||
    qualification.qualified !== true ||
    qualification.version !== release.version ||
    qualification.productIdentity?.exactMark !== EXACT_MARK ||
    qualification.productIdentity?.principle !== PRINCIPLE
  ) {
    throw new Error(
      'released product qualification does not independently prove the matching version and exact mark',
    );
  }
  const roots = new Set(
    array(release.artifactRoots).map((item) => object(item).sha256),
  );
  if (!roots.has(`sha256:${qualification.identity?.archiveSha256 || ''}`)) {
    throw new Error(
      'released product qualification archive root does not match the release',
    );
  }
  for (const record of array(
    object(object(index.layers).class9CapabilityTruth).records,
  )) {
    const segments = String(object(record).qualificationCheck || '').split('.');
    let value = qualification;
    for (const segment of segments) value = object(value)[segment];
    if (value !== true) {
      throw new Error(
        `Class 9 ${object(record).planId || '<unknown>'} qualification check is not true`,
      );
    }
  }
  return {
    acquisition: acquisition.publicUrl,
    action: acquisition.acquisitionUrl,
    product: product.publicUrl,
    version: release.version,
    sourceSha: release.sourceSha,
    artifactRoots: [...roots],
  };
}

function parseArgs(argv) {
  const options = {
    prepare: false,
    release: false,
    readback: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (['--prepare', '--release', '--readback', '--json'].includes(arg)) {
      options[arg.slice(2)] = true;
      continue;
    }
    if (
      ![
        '--input',
        '--output',
        '--source-sha',
        '--tag',
        '--channel',
        '--version',
        '--deployment-coordinate',
        '--receipts',
      ].includes(arg)
    ) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (!argv[index + 1]) throw new Error(`${arg} requires a value`);
    options[arg.slice(2).replaceAll('-', '_')] = argv[++index];
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.prepare === options.release) {
    throw new Error('choose exactly one of --prepare or --release');
  }
  const output = path.resolve(
    options.output || '.buildchain/release-evidence/ungfu-public-use.json',
  );
  const index = options.prepare
    ? createUngfuEvidencePreparation({
        sourceSha:
          options.source_sha ||
          process.env.BUILDCHAIN_RELEASE_SOURCE_SHA ||
          undefined,
        tag: options.tag || process.env.BUILDCHAIN_RELEASE_TAG || undefined,
        channel:
          options.channel ||
          process.env.BUILDCHAIN_RELEASE_CHANNEL ||
          undefined,
        version: options.version || process.env.BUILDCHAIN_RELEASE_VERSION,
        deploymentCoordinate:
          options.deployment_coordinate ||
          process.env.BUILDCHAIN_RELEASE_DEPLOYMENT_COORDINATE,
      })
    : (() => {
        const receiptSetPath = path.resolve(
          options.receipts ||
            process.env.BUILDCHAIN_RELEASE_ACTIVATION_RECEIPTS ||
            '',
        );
        if (
          !options.receipts &&
          !process.env.BUILDCHAIN_RELEASE_ACTIVATION_RECEIPTS
        ) {
          throw new Error(
            '--release requires --receipts or BUILDCHAIN_RELEASE_ACTIVATION_RECEIPTS',
          );
        }
        const receiptSet = readJson(receiptSetPath, 'activation receipt set');
        return createUngfuReleaseEvidenceFromReceipts(
          receiptSet,
          loadReceiptDocuments(receiptSet, receiptSetPath),
        );
      })();
  const issues = validateUngfuReleaseEvidence(index, {
    requireReleased: options.release,
  });
  if (issues.length > 0) {
    throw new Error(issues.join('; '));
  }
  const readback = options.readback
    ? await readBackUngfuReleaseEvidence(index)
    : undefined;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(index, null, 2)}\n`);
  const result = {
    schema: options.release
      ? 'kungfu.ungfu-release-evidence-result/v1'
      : 'kungfu.ungfu-release-evidence-preparation-result/v1',
    state: index.state,
    files: [path.relative(process.cwd(), output).split(path.sep).join('/')],
    releasedUseClaim:
      options.release &&
      index.state === 'released-observation' &&
      Boolean(readback),
    firstUseDateClaim: null,
    legalConclusion: 'not-made',
    ...(readback ? { readback } : {}),
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `[ungfu-release-evidence] state=${result.state} file=${result.files[0]} legal-conclusion=not-made\n`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[ungfu-release-evidence] ${error.message}`);
    process.exitCode = 1;
  });
}
