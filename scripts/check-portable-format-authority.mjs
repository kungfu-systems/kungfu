#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACT_PATH =
  'framework/spec/format/kungfu-portable-format-authority.contract.json';

const REQUIRED_TERMS = [
  'Episode Manifest',
  'import/export manifest',
  'Spec Bundle Manifest',
  'package JSON Schema',
  'payload schema',
  'POD layout',
  'BFBS',
];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * @param {Record<string, unknown>} contract
 * @param {{root?: string, readSource?: (relative: string) => string}} [options]
 */
function validatePortableIdentity(contract, readSource, fail) {
  if (
    contract.schema !== 'kungfu.portable-format-authority.contract/v1' ||
    contract.id !== 'kungfu-portable-format-authority' ||
    contract.version !== 1
  )
    fail('composition contract identity drifted');

  const boundary = isObject(contract.boundary) ? contract.boundary : {};
  if (boundary.kind !== 'composition-contract')
    fail('portable authority must remain a composition contract');
  const notOneOf = Array.isArray(boundary.notOneOf) ? boundary.notOneOf : [];
  for (const forbidden of [
    'one-mega-schema',
    'one-global-version-number',
    'one-site-projection',
  ])
    if (!notOneOf.includes(forbidden))
      fail(`composition boundary no longer forbids ${forbidden}`);

  const decision = String(contract.decision || '');
  try {
    const adr = readSource(decision);
    if (
      !adr.includes('adr_id: KF-ADR-019f96a2-c686-76e1-9261-f6106aa50429') ||
      !adr.includes('decision_status: accepted')
    )
      fail('accepted authority decision identity drifted');
  } catch {
    fail(`missing authority decision: ${decision}`);
  }
}

function validatePortableAuthorityEntry(item, ids, roles, readSource, fail) {
  if (!isObject(item)) {
    fail('authority entry must be an object');
    return;
  }
  const protocolId = String(item.protocolId || '');
  const source = String(item.source || '');
  const sourceRole = String(item.sourceRole || '');
  if (!protocolId || ids.has(protocolId))
    fail(`duplicate or missing protocol id: ${protocolId || '<empty>'}`);
  ids.add(protocolId);
  if (!sourceRole || roles.has(sourceRole))
    fail(`duplicate or missing source role: ${sourceRole || '<empty>'}`);
  roles.add(sourceRole);
  for (const field of ['identityDomain', 'versionAxis', 'compatibilityOwner'])
    if (!String(item[field] || ''))
      fail(`${protocolId || '<unknown>'} has no ${field}`);
  let sourceText = '';
  try {
    sourceText = readSource(source);
  } catch {
    fail(`${protocolId || '<unknown>'} source is missing: ${source}`);
    return;
  }
  const markers = Array.isArray(item.identityMarkers)
    ? item.identityMarkers
    : [];
  if (markers.length === 0)
    fail(`${protocolId || '<unknown>'} has no identity markers`);
  for (const marker of markers)
    if (!sourceText.includes(String(marker)))
      fail(`${protocolId || '<unknown>'} identity marker drifted: ${marker}`);
}

function validatePortableAuthorities(contract, readSource, fail) {
  const authorities = Array.isArray(contract.authorities)
    ? contract.authorities
    : [];
  if (authorities.length < 12)
    fail('portable authority inventory is incomplete');
  const ids = new Set();
  const roles = new Set();
  for (const item of authorities)
    validatePortableAuthorityEntry(item, ids, roles, readSource, fail);
  return ids;
}

function validatePortableVocabulary(contract, ids, fail) {
  const terminology = isObject(contract.terminology)
    ? contract.terminology
    : {};
  for (const term of REQUIRED_TERMS) {
    const entry = isObject(terminology[term]) ? terminology[term] : {};
    const protocolId = String(entry.protocolId || '');
    if (!protocolId || !ids.has(protocolId))
      fail(`${term} does not resolve to an inventoried protocol`);
    if (!String(entry.meaning || '')) fail(`${term} has no bounded meaning`);
  }

  const axes = Array.isArray(contract.versionAxes) ? contract.versionAxes : [];
  const axisIds = axes.map((axis) =>
    isObject(axis) ? String(axis.id || '') : '',
  );
  if (axisIds.length < 8 || new Set(axisIds).size !== axisIds.length)
    fail('version axes are incomplete or not independent');
  for (const required of [
    'journal-format-epoch',
    'record-schema-version',
    'root-protocol-version',
    'portable-spec-version',
    'package-version',
  ])
    if (!axisIds.includes(required)) fail(`missing version axis: ${required}`);

  const projections = isObject(contract.projections)
    ? contract.projections
    : {};
  if (
    !String(projections.rule || '').includes(
      'may not redefine protocol identity',
    )
  )
    fail('projection authority boundary drifted');
}

function validatePortableReader(reader, expected, markers, readSource, fail) {
  if (reader.id !== expected.id) fail(expected.identityIssue);
  try {
    const source = readSource(String(reader.source || ''));
    if (markers.some((marker) => !source.includes(marker)))
      fail(expected.sourceIssue);
  } catch {
    fail(`${expected.missingIssue}: ${reader.source || '<empty>'}`);
  }
}

function validatePortableReaders(contract, readSource, fail) {
  const status = isObject(contract.status) ? contract.status : {};
  if (status.requiredReader !== 'implemented')
    fail('required-reader authority is not implemented');
  if (status.migrationRepair !== 'implemented')
    fail('migration and repair authority is not implemented');
  const readers = isObject(contract.readers) ? contract.readers : {};
  const requiredReader = isObject(readers.requiredReader)
    ? readers.requiredReader
    : {};
  validatePortableReader(
    requiredReader,
    {
      id: 'kungfu-required-reader',
      identityIssue: 'required-reader identity drifted',
      sourceIssue: 'required-reader source identity drifted',
      missingIssue: 'missing required-reader source',
    },
    [
      '"schema": "kungfu.required-reader.contract/v1"',
      '"id": "kungfu-required-reader"',
    ],
    readSource,
    fail,
  );
  const migrationProtocol = isObject(readers.migrationProtocol)
    ? readers.migrationProtocol
    : {};
  validatePortableReader(
    migrationProtocol,
    {
      id: 'kungfu-format-migration',
      identityIssue: 'migration protocol identity drifted',
      sourceIssue: 'migration protocol source identity drifted',
      missingIssue: 'missing migration protocol source',
    },
    [
      '"schema": "kungfu.format-migration.contract/v1"',
      '"id": "kungfu-format-migration"',
    ],
    readSource,
    fail,
  );
}

/**
 * @param {Record<string, unknown>} contract
 * @param {{root?: string, readSource?: (relative: string) => string}} [options]
 */
export function validatePortableFormatAuthority(contract, options = {}) {
  const root = options.root || ROOT;
  const readSource =
    options.readSource ||
    ((relative) => fs.readFileSync(path.join(root, relative), 'utf8'));
  /** @type {string[]} */
  const issues = [];
  const fail = (message) => issues.push(message);
  validatePortableIdentity(contract, readSource, fail);
  const ids = validatePortableAuthorities(contract, readSource, fail);
  validatePortableVocabulary(contract, ids, fail);
  validatePortableReaders(contract, readSource, fail);
  return issues;
}
export function checkPortableFormatAuthority(root = ROOT) {
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, CONTRACT_PATH), 'utf8'),
  );
  const issues = validatePortableFormatAuthority(contract, { root });
  if (
    /^qualified-v[1-9][0-9]*$/u.test(
      contract.status?.crossVersionConformance || '',
    )
  ) {
    const corpus = contract.readers?.retainedConformanceCorpus;
    if (!corpus || corpus.id !== 'kungfu-portable-format-vectors')
      issues.push('qualified cross-version corpus binding is missing');
    else {
      const index = JSON.parse(
        fs.readFileSync(path.join(root, corpus.source), 'utf8'),
      );
      if (
        index.latestRelease !== corpus.release ||
        index.latestReleaseRoot !== corpus.releaseRoot
      )
        issues.push('qualified cross-version corpus release root drifted');
    }
  }
  if (issues.length > 0)
    throw new Error(
      `portable format authority drift:\n- ${issues.join('\n- ')}`,
    );
  return {
    contract: CONTRACT_PATH,
    authorities: contract.authorities.length,
    versionAxes: contract.versionAxes.length,
    terminology: Object.keys(contract.terminology).length,
  };
}

function main() {
  const result = checkPortableFormatAuthority();
  console.log(
    `[portable-format-authority] contract=${result.contract} authorities=${result.authorities} axes=${result.versionAxes} terms=${result.terminology}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    main();
  } catch (error) {
    console.error(
      `[portable-format-authority] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
