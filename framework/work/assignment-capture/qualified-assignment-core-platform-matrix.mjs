#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const MATRIX_PATH = 'docs/shifu/qualified-assignment-core-platform-matrix.json';
// Ordered rows are part of the Assignment capture and transport identity.
const REQUIRED_ROWS = [
  'darwin-arm64-cp313',
  'linux-x86_64-cp313',
  'windows-x86_64-cp313',
];
const SHA = /^[0-9a-f]{40}$/u;
const ROW_ID = /^[a-z0-9][a-z0-9_-]*$/u;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function exactKeys(value, keys, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    throw new Error(`Qualified Core platform matrix ${label} fields drifted`);
  }
}

function validateRow(row) {
  exactKeys(
    row,
    [
      'id',
      'operatingSystem',
      'architecture',
      'pythonAbi',
      'runner',
      'buildInfo',
      'payload',
    ],
    `row ${row?.id || 'unknown'}`,
  );
  exactKeys(
    row.runner,
    ['label', 'environment', 'os', 'arch', 'shell'],
    `runner ${row.id}`,
  );
  exactKeys(
    row.buildInfo,
    ['osVersionPrefix', 'architectureToken'],
    `buildInfo ${row.id}`,
  );
  exactKeys(row.payload, ['targetRoot', 'entries'], `payload ${row.id}`);
  if (
    !ROW_ID.test(row.id) ||
    row.pythonAbi !== 'cp313' ||
    row.runner.environment !== 'github-hosted' ||
    !['bash', 'pwsh'].includes(row.runner.shell) ||
    (row.operatingSystem === 'windows'
      ? row.runner.shell !== 'pwsh'
      : row.runner.shell !== 'bash') ||
    row.payload.targetRoot !== 'framework/core/dist/kungfu' ||
    !Array.isArray(row.payload.entries) ||
    row.payload.entries.length < 3
  ) {
    throw new Error(`Qualified Core platform matrix row is invalid: ${row.id}`);
  }
  const roles = [];
  for (const entry of row.payload.entries) {
    exactKeys(
      entry,
      ['role', 'pathPattern', 'type', 'mode'],
      `payload entry ${row.id}`,
    );
    if (
      entry.type !== 'regular-file' ||
      !['0644', '0755'].includes(entry.mode)
    ) {
      throw new Error(
        `Qualified Core platform matrix payload metadata is invalid: ${row.id}`,
      );
    }
    // Compile once at contract admission so producer and consumer never treat
    // a malformed pattern as an absent platform artifact.
    new RegExp(entry.pathPattern, 'u');
    roles.push(entry.role);
  }
  if (
    JSON.stringify(roles.sort()) !== JSON.stringify([...new Set(roles)].sort())
  ) {
    throw new Error(
      `Qualified Core platform matrix payload roles collide: ${row.id}`,
    );
  }
}

export function qualifiedCorePlatformMatrix(repositoryRoot = ROOT) {
  const matrix = readJson(path.join(repositoryRoot, MATRIX_PATH));
  exactKeys(
    matrix,
    ['schema', 'status', 'owner', 'shared', 'rows'],
    'top-level',
  );
  exactKeys(
    matrix.shared,
    [
      'dependencyLocks',
      'toolchainFacts',
      'artifactNaming',
      'qualificationPolicy',
      'promotionPolicy',
    ],
    'shared',
  );
  if (
    matrix.schema !== 'shifu.qualified-assignment-core-platform-matrix/v1' ||
    matrix.status !== 'development' ||
    matrix.owner !== 'shifu' ||
    !Array.isArray(matrix.rows)
  ) {
    throw new Error('Qualified Core platform matrix identity drifted');
  }
  for (const row of matrix.rows) validateRow(row);
  const rowIds = matrix.rows.map(({ id }) => id);
  if (
    JSON.stringify(rowIds) !== JSON.stringify(REQUIRED_ROWS) ||
    JSON.stringify(rowIds) !== JSON.stringify([...new Set(rowIds)])
  ) {
    throw new Error(
      'Qualified Core platform matrix must contain the exact ordered supported rows',
    );
  }
  const identities = matrix.rows.map(
    (row) => `${row.operatingSystem}/${row.architecture}/${row.pythonAbi}`,
  );
  if (new Set(identities).size !== identities.length) {
    throw new Error('Qualified Core platform matrix identities collide');
  }
  return matrix;
}

export function qualifiedCorePlatformRow(rowId, repositoryRoot = ROOT) {
  const row = qualifiedCorePlatformMatrix(repositoryRoot).rows.find(
    ({ id }) => id === rowId,
  );
  if (!row) {
    throw new Error(`Qualified Core platform row is unsupported: ${rowId}`);
  }
  return row;
}

export function qualifiedCorePlatformRowForIdentity(
  { operatingSystem, architecture, pythonAbi },
  repositoryRoot = ROOT,
) {
  const matches = qualifiedCorePlatformMatrix(repositoryRoot).rows.filter(
    (row) =>
      row.operatingSystem === operatingSystem &&
      row.architecture === architecture &&
      row.pythonAbi === pythonAbi,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Qualified Core platform identity is unsupported: ${operatingSystem}/${architecture}/${pythonAbi}`,
    );
  }
  return matches[0];
}

export function qualifiedCorePlatformRowForHost(
  platform,
  architecture,
  repositoryRoot = ROOT,
) {
  const operatingSystem =
    platform === 'win32'
      ? 'windows'
      : platform === 'darwin'
        ? 'darwin'
        : platform;
  const exactArchitecture =
    architecture === 'x64' || architecture === 'x86_64' ? 'x64' : architecture;
  return qualifiedCorePlatformRowForIdentity(
    {
      operatingSystem,
      architecture: exactArchitecture,
      pythonAbi: 'cp313',
    },
    repositoryRoot,
  );
}

export function qualifiedCoreArtifactName(
  kind,
  commit,
  rowId,
  repositoryRoot = ROOT,
) {
  if (!['candidate', 'promoted', 'matrixIndex'].includes(kind)) {
    throw new Error(`Qualified Core artifact kind is unsupported: ${kind}`);
  }
  if (!SHA.test(commit)) {
    throw new Error('Qualified Core artifact commit must be exact');
  }
  if (kind !== 'matrixIndex') qualifiedCorePlatformRow(rowId, repositoryRoot);
  const template =
    qualifiedCorePlatformMatrix(repositoryRoot).shared.artifactNaming[kind];
  return template.replace('{commit}', commit).replace('{row}', rowId || '');
}

export { MATRIX_PATH, REQUIRED_ROWS };
