// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  ADOPTER_DELIVERY_GATE_REQUEST_CONTRACT,
  createAdopterDeliveryGate,
  createGitCommitArtifactProfile,
} from '@kungfu-tech/buildchain/adopter-delivery-gate';
import {
  KFD_ADOPTER_CATEGORY_PROTOCOL_ID,
  KFD_ADOPTER_CATEGORY_PROTOCOL_VERSION,
  createKfdAdopterCategoryProtocolDriver,
} from '@kungfu-tech/buildchain/kfd-adopter-category-driver';

const require = createRequire(import.meta.url);
const SUPPORTED = Object.freeze(['kfd-4', 'kfd-5', 'kfd-7']);
const SUPPORTED_SET = new Set(SUPPORTED);
const CONTRACT = 'kungfu-buildchain-kfd-support-projection';
const GATE_CONTRACT = 'kungfu-buildchain-kfd-product-gate';
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const kfdPackage = require('@kungfu-tech/kfd/package.json');
const kfdStandards = require('@kungfu-tech/kfd/standards.json');

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

function digest(value) {
  return `sha256:${crypto.createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function fileDigest(file) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function issue(code, path, message, detail = {}) {
  return { level: 'error', code, path, message, ...detail };
}

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeRoot(value) {
  const root = text(value).toLowerCase();
  return root && !root.startsWith('sha256:') ? `sha256:${root}` : root;
}

function date(value) {
  const timestamp = Date.parse(text(value));
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function metadata(standard) {
  return kfdStandards?.standards?.[standard] || {};
}

function standardsDigest() {
  return fileDigest(require.resolve('@kungfu-tech/kfd/standards.json'));
}

function expectedIds() {
  return Array.from({ length: 13 }, (_, index) => `KFD-${index + 1}`);
}

function projectRow(row) {
  return Object.fromEntries(
    [
      'id',
      'key',
      'title',
      'supportStatus',
      'normative',
      'implementation',
      'verification',
      'buildchain',
      'releaseQualification',
      'claimClass',
      'knownLimitations',
      'owner',
      'nextGate',
    ].map((key) => [key, row?.[key]]),
  );
}

function validateRows(matrix, gates, issues) {
  const rows = Array.isArray(matrix?.rows) ? matrix.rows : [];
  const ids = rows.map((row) => row?.id);
  if (rows.length !== 13 || new Set(ids).size !== 13)
    issues.push(
      issue(
        'matrix-row-set',
        'rows',
        'support matrix must contain exactly one row for KFD-1 through KFD-13',
      ),
    );
  for (const id of expectedIds()) {
    const row = rows.find((entry) => entry?.id === id);
    if (!row) {
      issues.push(issue('matrix-row-missing', 'rows', `${id} is missing`));
      continue;
    }
    const key = id.toLowerCase();
    const standard = metadata(key);
    if (
      row.key !== key ||
      row?.normative?.status !== standard.status ||
      row?.normative?.revision !== standard.revision
    )
      issues.push(
        issue(
          'matrix-normative-drift',
          `rows.${id}.normative`,
          `${id} must match installed KFD status and revision`,
        ),
      );
    if (
      row?.releaseQualification?.shippedSupport === true &&
      (row?.implementation?.status !== 'implemented' ||
        row?.verification?.status !== 'passed' ||
        row?.buildchain?.gateStatus !== 'passed' ||
        !String(row.supportStatus || '').includes('supported'))
    )
      issues.push(
        issue(
          'matrix-shipped-widening',
          `rows.${id}`,
          `${id} cannot be shipped without implemented, verified, and passed Buildchain evidence`,
        ),
      );
  }
  for (const id of ['KFD-4', 'KFD-5']) {
    const row = rows.find((entry) => entry?.id === id);
    if (
      row?.supportStatus !== 'candidate' ||
      row?.releaseQualification?.shippedSupport !== false
    )
      issues.push(
        issue(
          'matrix-candidate-widening',
          `rows.${id}`,
          `${id} must remain a non-shipped candidate`,
        ),
      );
  }
  const kfd6 = rows.find((entry) => entry?.id === 'KFD-6');
  if (
    kfd6?.supportStatus !== 'unsupported' ||
    kfd6?.releaseQualification?.shippedSupport !== false ||
    kfd6?.buildchain?.gateStatus === 'passed'
  )
    issues.push(
      issue(
        'matrix-kfd6-barrier',
        'rows.KFD-6',
        'KFD-6 must remain explicitly unsupported and non-shipped',
      ),
    );
  for (let number = 8; number <= 13; number += 1) {
    const id = `KFD-${number}`;
    const row = rows.find((entry) => entry?.id === id);
    if (
      row?.supportStatus !== 'draft-adopter-evidence' ||
      row?.releaseQualification?.shippedSupport !== false ||
      row?.buildchain?.gateStatus === 'passed'
    )
      issues.push(
        issue(
          'matrix-draft-barrier',
          `rows.${id}`,
          `${id} must remain draft adopter evidence and non-shipped`,
        ),
      );
  }
  for (const standard of SUPPORTED) {
    const id = standard.toUpperCase();
    const row = rows.find((entry) => entry?.id === id);
    const gate = gates.get(standard);
    if (!gate) {
      issues.push(
        issue(
          'matrix-gate-missing',
          `rows.${id}.buildchain`,
          `${id} requires a Buildchain product-gate result`,
        ),
      );
      continue;
    }
    if (
      (row?.buildchain?.gateStatus === 'passed') !==
      (gate.status === 'passed')
    )
      issues.push(
        issue(
          'matrix-gate-disagreement',
          `rows.${id}.buildchain.gateStatus`,
          `${id} matrix and Buildchain gate disagree`,
        ),
      );
    if (row?.buildchain?.protocol !== `${GATE_CONTRACT}/v1`)
      issues.push(
        issue(
          'matrix-gate-protocol',
          `rows.${id}.buildchain.protocol`,
          `${id} must name the versioned Buildchain product-gate protocol`,
        ),
      );
  }
  return rows;
}

function alphaKfdSupportCompatibility(productGates) {
  function createKfdSupportProjection({
    matrix,
    matrixRoot = '',
    gateResults = [],
    authorityPath = '.buildchain/kfd/support-matrix.json',
    expectedSourceSha = '',
    checkedAt = new Date().toISOString(),
  } = {}) {
    const issues = [];
    if (
      !matrix ||
      typeof matrix !== 'object' ||
      Array.isArray(matrix) ||
      matrix.contract !== 'kungfu-kfd-support-matrix' ||
      matrix.schemaVersion !== 1
    )
      issues.push(
        issue(
          'matrix-contract',
          '',
          'support matrix must use kungfu-kfd-support-matrix v1',
        ),
      );
    if (
      matrix?.upstream?.package !== kfdPackage.name ||
      matrix?.upstream?.version !== kfdPackage.version ||
      matrix?.upstream?.standardsSha256 !== standardsDigest()
    )
      issues.push(
        issue(
          'matrix-standard-package',
          'upstream',
          'support matrix must bind the installed KFD package and standards bytes',
        ),
      );
    const gates = new Map();
    for (const [index, gate] of gateResults.entries()) {
      const result = productGates.validateKfdProductGateResult(gate, {
        expectedSourceSha,
        checkedAt,
      });
      if (!result.valid)
        issues.push(
          issue(
            'gate-result-invalid',
            `gateResults[${index}]`,
            'gate result is invalid',
            { gateIssues: result.issues },
          ),
        );
      if (gates.has(gate?.standard))
        issues.push(
          issue(
            'gate-result-duplicate',
            `gateResults[${index}].standard`,
            `${gate.standard} gate result is duplicated`,
          ),
        );
      gates.set(gate?.standard, gate);
    }
    const rows = validateRows(matrix, gates, issues);
    const projection = {
      schemaVersion: 1,
      contract: CONTRACT,
      matrix: {
        contract: matrix?.contract || '',
        root: normalizeRoot(matrixRoot) || digest(matrix),
        authorityPath: text(matrix?.authority?.path || authorityPath),
      },
      standardPackage: {
        name: kfdPackage.name,
        version: kfdPackage.version,
        standardsSha256: standardsDigest(),
      },
      gateResults: SUPPORTED.map((standard) => {
        const gate = gates.get(standard);
        return gate
          ? {
              standard,
              standardRevision: gate.standardRevision,
              sourceSha: gate?.source?.sha || '',
              evidenceCut: gate.evidenceCut,
              status: gate.status,
              gateRoot: gate.gateRoot,
              issueCount: Array.isArray(gate.issues) ? gate.issues.length : 0,
            }
          : { standard, status: 'missing', gateRoot: '', issueCount: 1 };
      }),
      rows: rows.map(projectRow),
      status: issues.length === 0 ? 'passed' : 'failed',
      nonClaims: [
        'This projection does not replace the product-owned support matrix.',
        'A passed Buildchain gate does not by itself activate, ship, or certify a KFD adoption.',
        'Candidate, unsupported, draft, and non-qualifying matrix states cannot be widened by this projection.',
      ],
      issues,
    };
    projection.projectionRoot = digest(projection);
    return projection;
  }

  function validateKfdSupportProjection(
    projection,
    { expectedSourceSha = '', checkedAt = new Date().toISOString() } = {},
  ) {
    const issues = [];
    if (
      !projection ||
      typeof projection !== 'object' ||
      Array.isArray(projection) ||
      projection.schemaVersion !== 1 ||
      projection.contract !== CONTRACT
    )
      return {
        valid: false,
        issues: [
          issue(
            'projection-contract',
            '',
            `projection must use ${CONTRACT} v1`,
          ),
        ],
      };
    const { projectionRoot: root, ...copy } = structuredClone(projection);
    if (root !== digest(copy))
      issues.push(
        issue(
          'projection-root',
          'projectionRoot',
          'support projection root does not match its content',
        ),
      );
    if (projection.status !== 'passed' || (projection.issues || []).length)
      issues.push(
        issue(
          'projection-status',
          'status',
          'release passport requires a passed support projection',
        ),
      );
    if (
      projection?.standardPackage?.name !== kfdPackage.name ||
      projection?.standardPackage?.version !== kfdPackage.version ||
      projection?.standardPackage?.standardsSha256 !== standardsDigest()
    )
      issues.push(
        issue(
          'projection-standard-package',
          'standardPackage',
          'support projection uses stale KFD package metadata',
        ),
      );
    if (!SHA256.test(text(projection?.matrix?.root)))
      issues.push(
        issue(
          'projection-matrix-root',
          'matrix.root',
          'support projection must bind the exact support matrix bytes',
        ),
      );
    if (!text(projection?.matrix?.authorityPath))
      issues.push(
        issue(
          'projection-matrix-authority',
          'matrix.authorityPath',
          'support projection must retain the product-owned matrix authority path',
        ),
      );
    const gates = new Map();
    for (const [index, gate] of (projection.gateResults || []).entries()) {
      if (!SUPPORTED_SET.has(gate?.standard)) {
        issues.push(
          issue(
            'projection-gate-standard',
            `gateResults[${index}].standard`,
            'projected gate must be kfd-4, kfd-5, or kfd-7',
          ),
        );
        continue;
      }
      if (gates.has(gate.standard))
        issues.push(
          issue(
            'projection-gate-duplicate',
            `gateResults[${index}].standard`,
            `${gate.standard} is duplicated`,
          ),
        );
      gates.set(gate.standard, gate);
      if (gate.standardRevision !== metadata(gate.standard).revision)
        issues.push(
          issue(
            'projection-gate-revision',
            `gateResults[${index}].standardRevision`,
            'projected gate revision is stale',
          ),
        );
      if (!SHA256.test(text(gate.gateRoot)))
        issues.push(
          issue(
            'projection-gate-root',
            `gateResults[${index}].gateRoot`,
            'projected gate must retain its gate root',
          ),
        );
      if (expectedSourceSha && gate.sourceSha !== expectedSourceSha)
        issues.push(
          issue(
            'projection-source',
            `gateResults[${index}].sourceSha`,
            'gate source must match the release source',
          ),
        );
      if (
        !Number.isFinite(date(gate?.evidenceCut?.expiresAt)) ||
        date(gate?.evidenceCut?.expiresAt) <= date(checkedAt)
      )
        issues.push(
          issue(
            'projection-stale-gate',
            `gateResults[${index}].evidenceCut.expiresAt`,
            'projected gate evidence is stale',
          ),
        );
    }
    validateRows({ rows: projection.rows }, gates, issues);
    if (!Array.isArray(projection.nonClaims) || !projection.nonClaims.length)
      issues.push(
        issue(
          'projection-non-claims',
          'nonClaims',
          'support projection must preserve non-claims',
        ),
      );
    return { valid: issues.length === 0, issues };
  }

  return { createKfdSupportProjection, validateKfdSupportProjection };
}

const COMPACT_SURFACE_IDS = ['kungfu.agent.', 'shifu.agent.', 'xinfa.agent.'];

function isCompactSurface(value) {
  return (
    value &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    (COMPACT_SURFACE_IDS.some((prefix) => value.id.startsWith(prefix)) ||
      ['xinfa.context', 'xinfa.expand'].includes(value.id))
  );
}

export function renderKfdJson(value) {
  const compact = [];
  const rendered = JSON.stringify(
    value,
    (_key, item) => {
      if (!isCompactSurface(item)) return item;
      const token = `__KUNGFU_COMPACT_SURFACE_${compact.length}__`;
      compact.push(JSON.stringify(item));
      return token;
    },
    2,
  );
  return `${compact.reduce(
    (text, item, index) =>
      text.replace(`"__KUNGFU_COMPACT_SURFACE_${index}__"`, item),
    rendered,
  )}\n`;
}

export const BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH =
  '.buildchain/kfd/kfd-1/contract-world.witness.json';
export const BUILDCHAIN_KFD1_RELEASE_GATE_PATH =
  '.buildchain/kfd/kfd-1/release-gate.json';
export const BUILDCHAIN_KFD1_VERIFY_RESULT_PATH =
  '.buildchain/kfd/kfd-1/verify-result.json';
export const BUILDCHAIN_KFD2_DIR = '.buildchain/kfd/kfd-2';
export const BUILDCHAIN_KFD2_REGISTRY_PATH =
  '.buildchain/kfd/kfd-2/registry.json';
export const BUILDCHAIN_KFD3_DIR = '.buildchain/kfd/kfd-3';
export const KFD3_DEFAULT_REGISTRY_PATH = '.buildchain/kfd/kfd-3/surfaces.json';

export async function loadBuildchainKfdRuntime() {
  try {
    const [{ kfd1, kfd2, kfd3 }, productGates] = await Promise.all([
      import('@kungfu-tech/buildchain-alpha/kfd'),
      import('@kungfu-tech/buildchain-alpha/kfd-product-gates'),
    ]);
    const support =
      typeof productGates.createKfdSupportProjection === 'function' &&
      typeof productGates.validateKfdSupportProjection === 'function'
        ? {}
        : alphaKfdSupportCompatibility(productGates);
    return { kfd1, kfd2, kfd3, productGates: { ...productGates, ...support } };
  } catch (error) {
    if (
      error &&
      error.code === 'ERR_MODULE_NOT_FOUND' &&
      String(error.message).includes('@kungfu-tech/buildchain-alpha')
    )
      return null;
    throw error;
  }
}

export function gitValue(root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function isGitAncestor(root, sourceSha, headSha) {
  return (
    spawnSync('git', ['merge-base', '--is-ancestor', sourceSha, headSha], {
      cwd: root,
      stdio: 'ignore',
    }).status === 0
  );
}

export function resolveGitBoundKfdEvidenceSourceSha({
  root,
  write,
  committed,
  configured,
  prepareHistory,
  assertBinding,
  selectSourceSha,
  findTreeEquivalentAncestor,
}) {
  if (!write) prepareHistory(root, { requiredCommit: committed });
  const headSha = gitValue(root, ['rev-parse', 'HEAD']);
  return assertBinding({
    sourceSha: selectSourceSha({ write, configured, committed, headSha }),
    headSha,
    isAncestor: (sourceSha, candidateHeadSha) =>
      isGitAncestor(root, sourceSha, candidateHeadSha),
    findTreeEquivalentAncestor: (sourceSha, candidateHeadSha) =>
      findTreeEquivalentAncestor(sourceSha, candidateHeadSha, (args) =>
        gitValue(root, args),
      ),
  });
}

export function releaseCandidateKfdRoot({ defaultRoot, receiptPath }) {
  return receiptPath?.trim() ? process.cwd() : defaultRoot;
}

export function loadSealedKfdUpstreamAggregate({
  receiptPath,
  aggregatePath,
  displayPath,
  quiet,
  readAggregate,
}) {
  const receipt = receiptPath?.trim();
  if (!receipt) return null;
  if (!fs.existsSync(receipt))
    throw new Error(
      `release-candidate recovery receipt is missing: ${receipt}`,
    );
  const aggregate = readAggregate(aggregatePath);
  if (
    aggregate.contract !== 'kungfu-upstream-kfd-aggregate' ||
    aggregate.source?.generator !== 'scripts/buildchain-kfd-evidence.mjs' ||
    !Array.isArray(aggregate.upstreams) ||
    aggregate.upstreams.length === 0
  )
    throw new Error(
      'sealed release-candidate KFD upstream aggregate is invalid',
    );
  if (!quiet)
    console.log(
      `reused sealed release-candidate KFD upstream aggregate from ${displayPath}`,
    );
  return aggregate;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function assertPair(root, source, projection, canonicalProjection = false) {
  const sourceFile = path.join(root, source);
  const projectionFile = path.join(root, projection);
  if (!fs.existsSync(sourceFile) || !fs.existsSync(projectionFile))
    throw new Error(
      `cold KFD projection is missing: ${source} -> ${projection}`,
    );
  const sourceBytes = fs.readFileSync(sourceFile);
  const expected = canonicalProjection
    ? Buffer.from(`${JSON.stringify(JSON.parse(sourceBytes), null, 2)}\n`)
    : sourceBytes;
  if (!expected.equals(fs.readFileSync(projectionFile)))
    throw new Error(`cold KFD projection differs: ${source} -> ${projection}`);
}

export function checkColdBuildchainKfd(root) {
  const pairs = [
    [
      BUILDCHAIN_KFD1_CONTRACT_WORLD_WITNESS_PATH,
      'developer/sdk/kfd/kfd-1/contract-world.witness.json',
    ],
    [
      BUILDCHAIN_KFD1_RELEASE_GATE_PATH,
      'developer/sdk/kfd/kfd-1/release-gate.json',
    ],
    [
      BUILDCHAIN_KFD1_VERIFY_RESULT_PATH,
      'developer/sdk/kfd/kfd-1/verify-result.json',
    ],
    [KFD3_DEFAULT_REGISTRY_PATH, 'developer/sdk/kfd/kfd-3-surfaces.json'],
    [
      '.buildchain/kfd/kfd-2/release-claims.json',
      'developer/sdk/kfd/kfd-2/release-claims.json',
    ],
    [
      '.buildchain/kfd/support-matrix.json',
      'developer/sdk/kfd/support-matrix.json',
      true,
    ],
  ];
  const claimsDir = path.join(root, BUILDCHAIN_KFD2_DIR, 'claims');
  for (const name of fs
    .readdirSync(claimsDir)
    .filter((value) => value.endsWith('.json'))
    .sort())
    pairs.push([
      `${BUILDCHAIN_KFD2_DIR}/claims/${name}`,
      `developer/sdk/kfd/kfd-2/claims/${name}`,
    ]);
  for (const pair of pairs) assertPair(root, ...pair);
  for (const base of [BUILDCHAIN_KFD2_DIR, 'developer/sdk/kfd/kfd-2']) {
    const args = fs
      .readFileSync(path.join(root, base, 'buildchain-claim-args.txt'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => line.replace(`--kfd-2-claim-json ${base}/claims/`, ''))
      .sort();
    const claims = fs
      .readdirSync(path.join(root, base, 'claims'))
      .filter((name) => name.endsWith('.json'))
      .sort();
    if (JSON.stringify(args) !== JSON.stringify(claims))
      throw new Error(`cold KFD-2 claim arguments differ from ${base}/claims`);
  }

  const verify = readJson(path.join(root, BUILDCHAIN_KFD1_VERIFY_RESULT_PATH));
  if (
    verify.contract !== 'kungfu-buildchain-kfd-1-verify-result' ||
    verify.ok !== true ||
    !Array.isArray(verify.issues) ||
    verify.issues.length !== 0
  )
    throw new Error('cold KFD-1 verify result is not qualifying');
  const registry = readJson(path.join(root, KFD3_DEFAULT_REGISTRY_PATH));
  if (
    registry.contract !== 'kungfu-buildchain-kfd-3-surface-registry' ||
    !Array.isArray(registry.surfaces) ||
    registry.surfaces.length === 0
  )
    throw new Error('cold KFD-3 registry is not a closed non-empty projection');
  const aggregate = readJson(
    path.join(root, 'developer/sdk/kfd/upstream-aggregate.json'),
  );
  if (
    aggregate.contract !== 'kungfu-upstream-kfd-aggregate' ||
    !Array.isArray(aggregate.upstreams)
  )
    throw new Error('cold KFD upstream aggregate is invalid');
  const lockPath = path.join(root, '.buildchain/alpha-contract-lock.json');
  const lock = readJson(lockPath);
  if (
    lock?.buildchain?.ref !== 'v3-alpha' ||
    !/^[0-9a-f]{40}$/.test(lock?.buildchain?.resolvedSha || '') ||
    !/^sha256:[0-9a-f]{64}$/.test(lock?.buildchain?.contractDigest || '')
  )
    throw new Error('cold KFD check is not bound to the Buildchain alpha lock');
  return {
    ok: true,
    mode: 'cold-source-check',
    buildchainRuntime: 'not-installed',
    contractLock: relative(root, lockPath),
    projectionPairs: pairs.length,
    kfd3Surfaces: registry.surfaces.length,
  };
}

export const KUNGFU_KFD_PRODUCT_RUNTIME_CATEGORY_GATE =
  'kungfu-kfd-product-runtime-category-gate/v1';

const GIT_COMMIT_PROFILE = Object.freeze({
  id: 'buildchain.artifact/git-commit',
  version: '1.0.0',
});

const productRuntimeCategoryGate = createAdopterDeliveryGate({
  drivers: [createKfdAdopterCategoryProtocolDriver()],
  artifactProfiles: [createGitCommitArtifactProfile(GIT_COMMIT_PROFILE)],
});

function requireCategoryObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  return value;
}

export function createKungfuKfdProductRuntimeCategoryRequest(instanceManifest) {
  const instance = requireCategoryObject(instanceManifest, 'category instance');
  const project = requireCategoryObject(
    instance.project,
    'category instance project',
  );
  return {
    schemaVersion: 1,
    contract: ADOPTER_DELIVERY_GATE_REQUEST_CONTRACT,
    protocol: {
      id: KFD_ADOPTER_CATEGORY_PROTOCOL_ID,
      version: KFD_ADOPTER_CATEGORY_PROTOCOL_VERSION,
    },
    artifactProfile: GIT_COMMIT_PROFILE,
    project: {
      instanceId: instance.instanceId,
      adopterId: project.adopterId,
    },
    artifact: structuredClone(project.artifact),
    declaration: structuredClone(instance),
  };
}

export function evaluateKungfuKfdProductRuntimeCategory({
  instanceManifest,
  adopterManifest,
  verifiedAt,
  maxAgeSeconds,
} = {}) {
  return productRuntimeCategoryGate.evaluate(
    createKungfuKfdProductRuntimeCategoryRequest(instanceManifest),
    {
      adopterManifest: structuredClone(
        requireCategoryObject(adopterManifest, 'full-cut adopter manifest'),
      ),
      verifiedAt,
      maxAgeSeconds,
    },
  );
}
