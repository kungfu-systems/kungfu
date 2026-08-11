// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

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

export function alphaKfdSupportCompatibility(productGates) {
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
