// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  contentRoot,
  executeReferenceMigration,
  negotiateFormat,
  planEvidencePreservingRepair,
} from './check-format-migration-contract.mjs';
import {
  generatePortableFormatVectors,
  sha256,
} from './generate-portable-format-vectors.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH =
  'framework/spec/format/conformance/portable-format-vectors/index.json';
const CURRENT_EPOCH = 0xe3b24c8d;
const PAGE_HEADER_SIZE = 32;
const FRAME_HEADER_SIZE = 72;
const PAGE_SIZE = 2 * 1024 * 1024;

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function reject(failureCode) {
  return {
    outcome: 'reject',
    classification: 'malformed',
    reason: 'FORMAT_TUPLE_MALFORMED',
    failureCode,
    writeOccurred: false,
  };
}

function classifyJournal(bytes) {
  if (bytes.length < PAGE_HEADER_SIZE)
    return reject('E_READER_MALFORMED_FRAMING');
  const epoch = bytes.readUInt32LE(0);
  if (epoch !== CURRENT_EPOCH)
    return {
      outcome: 'migration-required',
      classification: 'unsupported-edge',
      reason: 'FORMAT_UNSUPPORTED_EDGE',
      failureCode: 'E_MIGRATION_UNSUPPORTED_EDGE',
      writeOccurred: false,
    };
  if (
    bytes.readUInt32LE(4) !== PAGE_HEADER_SIZE ||
    bytes.readBigUInt64LE(8) !== BigInt(PAGE_SIZE) ||
    bytes.readUInt32LE(16) !== FRAME_HEADER_SIZE ||
    bytes.readBigUInt64LE(24) > BigInt(bytes.length)
  )
    return reject('E_READER_MALFORMED_FRAMING');
  if (bytes.length < PAGE_HEADER_SIZE + FRAME_HEADER_SIZE)
    return reject('E_READER_MALFORMED_FRAMING');
  const carrierType = bytes.readInt32LE(PAGE_HEADER_SIZE + 24);
  if (carrierType <= 0)
    return {
      outcome: 'read-degraded',
      classification: 'optional-unknown',
      reason: 'FORMAT_OPTIONAL_UNKNOWN',
      failureCode: 'E_READER_UNKNOWN_CARRIER',
      writeOccurred: false,
    };
  return {
    outcome: 'read',
    classification: 'exact',
    reason: 'FORMAT_EXACT',
    failureCode: '',
    writeOccurred: false,
  };
}

function parseLegacyAtoms(bytes) {
  if (bytes.length < 8) throw new Error('legacy atom count is missing');
  const count = Number(bytes.readBigUInt64BE(0));
  let offset = 8;
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > bytes.length)
      throw new Error(`legacy atom ${index} length is missing`);
    const length = Number(bytes.readBigUInt64BE(offset));
    offset += 8;
    if (offset + length > bytes.length)
      throw new Error(`legacy atom ${index} body is truncated`);
    offset += length;
  }
  if (offset !== bytes.length) throw new Error('legacy atom tail is unframed');
}

export function classifyRetainedVector(vector, bytes) {
  if (vector.layer === 'compatibility-tuple') {
    let payload;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      return reject('E_READER_MALFORMED_FRAMING');
    }
    if (
      payload?.schema !== 'kungfu.format.compatibility-tuple-vector/v1' ||
      !payload.tuple ||
      typeof payload.tuple !== 'object' ||
      Array.isArray(payload.tuple)
    )
      return reject('E_MIGRATION_TUPLE_MALFORMED');
    const contract = readJson(
      ROOT,
      'framework/spec/format/kungfu-format-migration.contract.json',
    );
    const negotiated = negotiateFormat(contract, { source: payload.tuple });
    const classification = {
      FORMAT_EXACT: 'exact',
      FORMAT_OPTIONAL_UNKNOWN: 'optional-unknown',
      FORMAT_SUPPORTED_MIGRATION: 'supported-edge',
      FORMAT_UNSUPPORTED_EDGE: 'unsupported-edge',
      FORMAT_DOWNGRADE_REFUSED: 'downgrade',
      FORMAT_TUPLE_MALFORMED: 'malformed',
    }[negotiated.reason];
    return {
      outcome: negotiated.readerOutcome,
      classification,
      reason: negotiated.reason,
      failureCode: negotiated.code || '',
      writeOccurred: false,
    };
  }
  if (vector.layer === 'journal-page') return classifyJournal(bytes);
  if (vector.protocol === 'sha256-length-framed-fields-v1') {
    parseLegacyAtoms(bytes);
    return {
      outcome: 'migration-required',
      classification: 'supported-edge',
      reason: 'FORMAT_SUPPORTED_MIGRATION',
      failureCode: '',
      writeOccurred: false,
    };
  }
  if (vector.protocol === 'kungfu.fact-root.canonical/v3')
    return {
      outcome: 'migration-required',
      classification: 'unsupported-edge',
      reason: 'FORMAT_UNSUPPORTED_EDGE',
      failureCode: 'E_MIGRATION_UNSUPPORTED_EDGE',
      writeOccurred: false,
    };
  if (vector.repair)
    return {
      outcome: 'preserve-only',
      classification: 'damage-evidence',
      reason: 'REPAIR_SOURCE_RETAINED',
      failureCode: 'E_READER_REQUIRED_MATERIAL_MISSING',
      writeOccurred: false,
    };
  if (
    vector.protocol === 'kungfu.fact-root.canonical/v2' &&
    bytes.subarray(0, 4).equals(Buffer.from('KFR2', 'ascii'))
  )
    return {
      outcome: 'read',
      classification: 'exact',
      reason: 'FORMAT_EXACT',
      failureCode: '',
      writeOccurred: false,
    };
  return reject('E_READER_MALFORMED_FRAMING');
}

function verifyMigrationAndRepair(root, vectors) {
  const contract = readJson(
    root,
    'framework/spec/format/kungfu-format-migration.contract.json',
  );
  const legacy = vectors.find(
    (vector) => vector.id === 'fact-root-v1-legacy-atoms',
  );
  const current = vectors.find(
    (vector) => vector.id === 'fact-root-v2-mapping-receipt',
  );
  const damaged = vectors.find(
    (vector) => vector.id === 'fact-root-v2-damaged-receipt',
  );
  assert(legacy && current && damaged);
  const request = {
    operationId: 'portable-vector-v1-fact-root-migration',
    edgeId: 'fact-root-v1-to-v2',
    sourceProtocol: legacy.protocol,
    targetProtocol: current.protocol,
    sourceRoot: legacy.byteRoot,
    successorRoot: current.byteRoot,
    sourceEvidenceRoots: [legacy.byteRoot],
    transformationEvidenceRoots: [current.byteRoot],
  };
  const first = executeReferenceMigration(contract, request);
  assert.equal(first.status, 'successor-receipt-projected');
  const retry = executeReferenceMigration(contract, request, [first.receipt]);
  assert.equal(retry.status, 'reconciled');
  assert.deepEqual(retry.receipt, first.receipt);
  const repair = planEvidencePreservingRepair({
    operationId: 'portable-vector-v1-repair',
    sourceRoot: damaged.byteRoot,
    damageEvidenceRoots: [damaged.byteRoot],
    replacementEvidenceRoots: [current.byteRoot],
    recoveredRanges: ['0:449'],
    unrecoveredRanges: ['449:466'],
    semanticsProved: false,
  });
  assert.equal(repair.status, 'rejected');
  assert.equal(repair.authorityChanged, false);
  assert.equal(repair.code, 'E_REPAIR_SEMANTIC_RECOVERY_UNPROVEN');
  assert.deepEqual(repair.damageEvidenceRoots, [damaged.byteRoot]);
}

export function checkPortableFormatVectors(root = ROOT) {
  if (root === ROOT) generatePortableFormatVectors();
  const index = readJson(root, INDEX_PATH);
  assert.equal(index.schema, 'kungfu.portable-format-vector-index/v1');
  assert.ok(index.releases.length >= 2);
  let previousReleaseRoot = '';
  for (const entry of index.releases) {
    const entryPath = path.join(path.dirname(INDEX_PATH), entry.path);
    const retained = readJson(root, entryPath);
    const retainedRoot = contentRoot(retained);
    assert.equal(retainedRoot, entry.root, `${entry.id}: release root drift`);
    assert.equal(
      entry.previousReleaseRoot,
      previousReleaseRoot,
      `${entry.id}: index chain drift`,
    );
    assert.equal(
      retained.previousReleaseRoot,
      previousReleaseRoot,
      `${entry.id}: release chain drift`,
    );
    previousReleaseRoot = retainedRoot;
  }
  const releaseEntry = index.releases.find(
    (entry) => entry.id === index.latestRelease,
  );
  assert.ok(releaseEntry, 'latest retained release is missing');
  const releasePath = path.join(path.dirname(INDEX_PATH), releaseEntry.path);
  const release = readJson(root, releasePath);
  const releaseRoot = contentRoot(release);
  assert.equal(releaseRoot, releaseEntry.root);
  assert.equal(releaseRoot, index.latestReleaseRoot);
  assert.equal(release.previousReleaseRoot, releaseEntry.previousReleaseRoot);
  assert.equal(
    release.historicalFixtureClassification.normativeWireEvidence,
    false,
  );
  const ids = new Set();
  const outcomes = new Set();
  const axes = new Set();
  for (const vector of release.vectors) {
    if (ids.has(vector.id))
      throw new Error(`duplicate vector id: ${vector.id}`);
    ids.add(vector.id);
    const vectorPath = path.join(path.dirname(releasePath), vector.path);
    const bytes = fs.readFileSync(path.join(root, vectorPath));
    if (bytes.length !== vector.byteLength)
      throw new Error(
        `${vector.id}: byte length ${bytes.length} != ${vector.byteLength}`,
      );
    const actualRoot = sha256(bytes);
    if (actualRoot !== vector.byteRoot)
      throw new Error(
        `${vector.id}: byte root ${actualRoot} != ${vector.byteRoot}`,
      );
    const actual = classifyRetainedVector(vector, bytes);
    assert.deepEqual(actual, vector.expected, `${vector.id}: outcome drift`);
    outcomes.add(actual.outcome);
    for (const axis of vector.axes || []) axes.add(axis);
  }
  assert.deepEqual([...outcomes].sort(), [
    'migration-required',
    'preserve-only',
    'read',
    'read-degraded',
    'reject',
  ]);
  assert.deepEqual(
    [
      'journalEpoch',
      'workspaceLayout',
      'recordSchemas',
      'payloadSchemas',
      'rootProtocols',
      'bundleManifest',
      'capabilities',
    ].filter((axis) => !axes.has(axis)),
    [],
    'latest retained release does not cover every compatibility axis',
  );
  verifyMigrationAndRepair(root, release.vectors);
  return {
    index: INDEX_PATH,
    releaseRoot,
    vectors: release.vectors.length,
    outcomes: outcomes.size,
    axes: axes.size,
  };
}

function main() {
  const result = checkPortableFormatVectors();
  console.log(
    `[portable-format-vectors] index=${result.index} release=${result.releaseRoot} vectors=${result.vectors} outcomes=${result.outcomes} axes=${result.axes}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    main();
  } catch (error) {
    console.error(
      `[portable-format-vectors] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
