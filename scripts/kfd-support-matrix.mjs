#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX_PATH = path.resolve(
  process.env.KUNGFU_KFD_SUPPORT_MATRIX_AUTHORITY ||
    path.join(ROOT, '.buildchain', 'kfd', 'support-matrix.json'),
);
const SDK_PROJECTION_PATH = path.join(
  ROOT,
  'developer',
  'sdk',
  'kfd',
  'support-matrix.json',
);
const DOC_PROJECTION_PATH = path.join(
  ROOT,
  'docs',
  'qualification',
  'kfd-support-matrix.md',
);
const require = createRequire(import.meta.url);
const KFD_ROOT = path.dirname(require.resolve('@kungfu-tech/kfd/package.json'));
const STANDARDS_PATH = path.join(KFD_ROOT, 'standards.json');
const RELEASE_ANCHOR_PATH = path.join(KFD_ROOT, 'kfd.release.json');
const KFD_PACKAGE_PATH = path.join(KFD_ROOT, 'package.json');

function sha256Buffer(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function fail(message) {
  throw new Error(message);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function validateMatrix(matrix) {
  if (matrix.contract !== 'kungfu-kfd-support-matrix') {
    fail(
      `unexpected support matrix contract: ${matrix.contract || '<missing>'}`,
    );
  }
  if (!Array.isArray(matrix.rows) || matrix.rows.length !== 13) {
    fail(
      `support matrix must contain exactly 13 rows, found ${matrix.rows?.length || 0}`,
    );
  }

  const standards = readJson(STANDARDS_PATH);
  const kfdPackage = readJson(KFD_PACKAGE_PATH);
  const releaseAnchor = readJson(RELEASE_ANCHOR_PATH);
  const expectedKeys = Array.from(
    { length: 13 },
    (_, index) => `kfd-${index + 1}`,
  );
  const actualKeys = matrix.rows.map((row) => row.key);
  if (new Set(actualKeys).size !== actualKeys.length) {
    fail('support matrix contains duplicate KFD keys');
  }
  if (actualKeys.join(',') !== expectedKeys.join(',')) {
    fail(
      `support matrix rows must be ordered kfd-1 through kfd-13, found ${actualKeys.join(',')}`,
    );
  }
  if (matrix.upstream.version !== kfdPackage.version) {
    fail(
      `KFD package version drift: matrix=${matrix.upstream.version} installed=${kfdPackage.version}`,
    );
  }
  if (matrix.upstream.line !== releaseAnchor.line) {
    fail(
      `KFD release line drift: matrix=${matrix.upstream.line} installed=${releaseAnchor.line}`,
    );
  }
  if (matrix.upstream.channel !== releaseAnchor.channel) {
    fail(
      `KFD release channel drift: matrix=${matrix.upstream.channel} installed=${releaseAnchor.channel}`,
    );
  }
  if (matrix.upstream.standardsSha256 !== sha256File(STANDARDS_PATH)) {
    fail('installed KFD standards.json root does not match the support matrix');
  }
  if (matrix.upstream.releaseAnchorSha256 !== sha256File(RELEASE_ANCHOR_PATH)) {
    fail('installed KFD release anchor root does not match the support matrix');
  }

  for (const row of matrix.rows) {
    const standard = standards.standards?.[row.key];
    if (!standard) fail(`${row.key} is absent from installed KFD standards`);
    const expectedId = row.key.toUpperCase();
    if (row.id !== expectedId) fail(`${row.key} id must be ${expectedId}`);
    if (
      row.normative.status !== standard.status ||
      row.normative.revision !== standard.revision ||
      row.normative.documentSha256 !== `sha256:${standard.document.sha256}`
    ) {
      fail(
        `${row.key} normative projection drifts from installed KFD metadata`,
      );
    }
    if (
      typeof row.implementation?.status !== 'string' ||
      !Array.isArray(row.implementation?.surfaces) ||
      typeof row.verification?.status !== 'string' ||
      !Array.isArray(row.verification?.evidenceRoots) ||
      typeof row.buildchain?.gateStatus !== 'string' ||
      typeof row.buildchain?.protocol !== 'string' ||
      typeof row.exposure?.sdk !== 'string' ||
      typeof row.exposure?.cli !== 'string' ||
      typeof row.exposure?.docs !== 'string' ||
      typeof row.releaseQualification?.status !== 'string' ||
      typeof row.releaseQualification?.shippedSupport !== 'boolean' ||
      !Array.isArray(row.releaseQualification?.evidenceRoots) ||
      typeof row.claimClass !== 'string' ||
      !Array.isArray(row.knownLimitations) ||
      typeof row.owner !== 'string' ||
      typeof row.nextGate !== 'string'
    ) {
      fail(`${row.key} is missing one or more required support dimensions`);
    }
    for (const evidence of [
      ...row.verification.evidenceRoots,
      ...row.releaseQualification.evidenceRoots,
    ]) {
      const evidencePath = path.join(ROOT, evidence.path);
      if (!fs.existsSync(evidencePath)) {
        fail(`${row.key} evidence is missing: ${evidence.path}`);
      }
      if (sha256File(evidencePath) !== evidence.sha256) {
        fail(`${row.key} evidence root drift: ${evidence.path}`);
      }
    }
    if (
      row.normative.status === 'draft' &&
      row.releaseQualification.shippedSupport
    ) {
      fail(`${row.key} is draft and cannot claim shipped support`);
    }
  }

  const byKey = Object.fromEntries(matrix.rows.map((row) => [row.key, row]));
  const shippedKeys = matrix.rows
    .filter((row) => row.releaseQualification.shippedSupport)
    .map((row) => row.key);
  const expectedShippedKeys = ['kfd-1', 'kfd-2', 'kfd-3', 'kfd-7'];
  if (shippedKeys.join(',') !== expectedShippedKeys.join(',')) {
    fail(
      `shipped support must remain exactly ${expectedShippedKeys.join(',')}, found ${shippedKeys.join(',') || '<none>'}`,
    );
  }
  if (
    byKey['kfd-6'].supportStatus !== 'unsupported' ||
    byKey['kfd-6'].implementation.status !== 'not-implemented' ||
    byKey['kfd-6'].releaseQualification.shippedSupport
  ) {
    fail('KFD-6 must remain an explicit unsupported non-adoption');
  }
  for (const key of ['kfd-4', 'kfd-5']) {
    if (byKey[key].supportStatus !== 'candidate') {
      fail(
        `${key} must remain a candidate until implementation, verification, and Buildchain gates close`,
      );
    }
  }
  for (const key of [
    'kfd-8',
    'kfd-9',
    'kfd-10',
    'kfd-11',
    'kfd-12',
    'kfd-13',
  ]) {
    if (
      byKey[key].supportStatus !== 'draft-adopter-evidence' ||
      byKey[key].claimClass !== 'draft-adopter-evidence'
    ) {
      fail(`${key} may expose only non-conforming draft adopter evidence`);
    }
  }
  return matrix;
}

function renderDocument(matrix) {
  const rows = matrix.rows
    .map(
      (row) =>
        `| ${row.id} | ${row.normative.status} r${row.normative.revision} | ${row.supportStatus} | ${row.implementation.status} | ${row.verification.status} | ${row.buildchain.gateStatus} | ${row.releaseQualification.status} | ${row.releaseQualification.shippedSupport ? 'yes' : 'no'} | ${row.nextGate} |`,
    )
    .join('\n');
  return `# Kungfu KFD support matrix

This document is generated from \`.buildchain/kfd/support-matrix.json\`. The KFD package remains the normative authority; this matrix is Kungfu's authority for adoption and support claims.

Source implementation is not the same as released support. Verification, Buildchain gating, and shipped release qualification are independent dimensions. The current Alpha release declaration ships ${matrix.rows
    .filter((row) => row.releaseQualification.shippedSupport)
    .map((row) => row.id)
    .join(
      ', ',
    )} only; the public claim becomes qualifying when the exact release passport is published.

| Standard | Normative | Product status | Implementation | Verification | Buildchain | Release qualification | Shipped | Next gate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${rows}

## Claim boundary

- KFD-1, KFD-2, KFD-3, and KFD-7 are the bounded shipped-support set for the current Alpha release declaration.
- KFD-3 uses Buildchain's product-declared registry audit directly; the former local fallback has been removed.
- KFD-4 passes one bounded observer/contrastive-replay product gate but remains a non-shipped adoption candidate.
- KFD-5 remains a non-shipped adoption candidate and its retained product gate fails on missing qualification evidence.
- KFD-6 is explicitly unsupported.
- KFD-8 through KFD-13 expose only non-conforming draft adopter evidence. They are not shipped support.
`;
}

function checkProjection(filePath, expected, label) {
  if (!fs.existsSync(filePath))
    fail(`${label} is missing: ${path.relative(ROOT, filePath)}`);
  const actual = fs.readFileSync(filePath, 'utf8');
  if (actual !== expected)
    fail(`${label} is stale: ${path.relative(ROOT, filePath)}`);
}

function main() {
  const mode = process.argv[2] || '--check';
  if (
    !['--check', '--validate', '--write'].includes(mode) ||
    process.argv.length > 3
  ) {
    fail(
      'usage: node scripts/kfd-support-matrix.mjs [--check|--validate|--write]',
    );
  }
  const matrix = validateMatrix(readJson(MATRIX_PATH));
  const sdkProjection = canonicalJson(matrix);
  const docProjection = renderDocument(matrix);
  if (mode === '--write') {
    fs.mkdirSync(path.dirname(SDK_PROJECTION_PATH), { recursive: true });
    fs.mkdirSync(path.dirname(DOC_PROJECTION_PATH), { recursive: true });
    fs.writeFileSync(SDK_PROJECTION_PATH, sdkProjection);
    fs.writeFileSync(DOC_PROJECTION_PATH, docProjection);
  } else if (mode === '--check') {
    checkProjection(
      SDK_PROJECTION_PATH,
      sdkProjection,
      'SDK support matrix projection',
    );
    checkProjection(
      DOC_PROJECTION_PATH,
      docProjection,
      'documentation support matrix projection',
    );
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        mode: mode.slice(2),
        rowCount: matrix.rows.length,
        matrixSha256: sha256File(MATRIX_PATH),
        shippedSupportCount: matrix.rows.filter(
          (row) => row.releaseQualification.shippedSupport,
        ).length,
      },
      null,
      2,
    )}\n`,
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[kfd-support-matrix] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}
