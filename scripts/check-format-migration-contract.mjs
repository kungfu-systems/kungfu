#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONTRACT_PATH =
  'framework/spec/format/kungfu-format-migration.contract.json';
const SHA256_ROOT = /^sha256:[0-9a-f]{64}$/u;

/** @param {unknown} value */
const isObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, member]) => [key, canonical(member)]),
    );
  return value;
}

/** @param {unknown} value */
export function contentRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

/** @param {Record<string, unknown>} contract */
function edges(contract) {
  const graph = isObject(contract.migrationGraph)
    ? contract.migrationGraph
    : {};
  return Array.isArray(graph.edges) ? graph.edges.filter(isObject) : [];
}

/**
 * @param {Record<string, unknown>} contract
 * @param {Record<string, unknown>} tuple
 */
function tupleIssues(contract, tuple) {
  const definition = isObject(contract.compatibilityTuple)
    ? contract.compatibilityTuple
    : {};
  const required = Array.isArray(definition.requiredAxes)
    ? definition.requiredAxes.map(String)
    : [];
  const missing = required.filter((axis) => !(axis in tuple));
  const unknown = Object.keys(tuple)
    .filter((axis) => !required.includes(axis))
    .map((axis) => `unknown:${axis}`);
  return [...missing, ...unknown];
}

/**
 * @param {Record<string, unknown>} contract
 * @param {{source: Record<string, unknown>, target?: Record<string, unknown>}} input
 */
export function negotiateFormat(contract, input) {
  const target =
    input.target ||
    (isObject(contract.currentTuple) ? contract.currentTuple : {});
  const source = input.source;
  const missing = [
    ...tupleIssues(contract, source),
    ...tupleIssues(contract, target),
  ];
  if (missing.length)
    return {
      readerOutcome: 'reject',
      reason: 'FORMAT_TUPLE_MALFORMED',
      nextAction: 'preserve-source-and-inspect',
      code: 'E_MIGRATION_TUPLE_MALFORMED',
      authorityChanged: false,
      differingAxes: [...new Set(missing)].sort(),
    };

  const differences = [];
  for (const axis of [
    'journalEpoch',
    'workspaceLayout',
    'recordSchemas',
    'payloadSchemas',
    'rootProtocols',
    'bundleManifest',
  ]) {
    const sourceValue = isObject(source[axis])
      ? canonical(source[axis])
      : source[axis];
    const targetValue = isObject(target[axis])
      ? canonical(target[axis])
      : target[axis];
    if (JSON.stringify(sourceValue) !== JSON.stringify(targetValue))
      differences.push(axis);
  }
  const sourceCapabilities = new Set(
    Array.isArray(source.capabilities) ? source.capabilities.map(String) : [],
  );
  const targetCapabilities = new Set(
    Array.isArray(target.capabilities) ? target.capabilities.map(String) : [],
  );
  const missingCapabilities = [...targetCapabilities].filter(
    (capability) => !sourceCapabilities.has(capability),
  );
  if (missingCapabilities.length) differences.push('capabilities');
  const optionalUnknownCapabilities = [...sourceCapabilities]
    .filter((capability) => !targetCapabilities.has(capability))
    .sort();
  if (differences.length === 0 && optionalUnknownCapabilities.length)
    return {
      readerOutcome: 'read-degraded',
      reason: 'FORMAT_OPTIONAL_UNKNOWN',
      nextAction: 'preserve-and-report',
      code: null,
      authorityChanged: false,
      differingAxes: ['capabilities'],
      optionalUnknownCapabilities,
    };
  if (differences.length === 0)
    return {
      readerOutcome: 'read',
      reason: 'FORMAT_EXACT',
      nextAction: 'continue',
      code: null,
      authorityChanged: false,
      differingAxes: [],
    };

  const sourceRoot = isObject(source.rootProtocols)
    ? source.rootProtocols.factRoot
    : undefined;
  const targetRoot = isObject(target.rootProtocols)
    ? target.rootProtocols.factRoot
    : undefined;
  const forward = edges(contract).find(
    (edge) => edge.from === sourceRoot && edge.to === targetRoot,
  );
  if (forward && differences.length === 1 && differences[0] === 'rootProtocols')
    return {
      readerOutcome: 'migration-required',
      reason: 'FORMAT_SUPPORTED_MIGRATION',
      nextAction: 'run-explicit-cold-path-migration',
      code: null,
      authorityChanged: false,
      differingAxes: differences,
      edgeId: forward.id,
    };

  const reverse = edges(contract).find(
    (edge) => edge.from === targetRoot && edge.to === sourceRoot,
  );
  if (reverse)
    return {
      readerOutcome: 'reject',
      reason: 'FORMAT_DOWNGRADE_REFUSED',
      nextAction: 'use-a-reader-that-supports-the-source',
      code: 'E_MIGRATION_DOWNGRADE_REFUSED',
      authorityChanged: false,
      differingAxes: differences,
    };
  return {
    readerOutcome: 'migration-required',
    reason: 'FORMAT_UNSUPPORTED_EDGE',
    nextAction: 'install-compatible-reader-or-export',
    code: 'E_MIGRATION_UNSUPPORTED_EDGE',
    authorityChanged: false,
    differingAxes: differences,
  };
}

/**
 * @param {Record<string, unknown>} contract
 * @param {Record<string, unknown>} request
 * @param {Record<string, unknown>[]} [priorReceipts]
 */
export function executeReferenceMigration(
  contract,
  request,
  priorReceipts = [],
) {
  const operationId = String(request.operationId || '');
  const requestRoot = contentRoot(request);
  const prior = priorReceipts.find(
    (receipt) => receipt.operationId === operationId,
  );
  if (prior) {
    if (prior.requestRoot === requestRoot)
      return { status: 'reconciled', receipt: prior, authorityChanged: false };
    return {
      status: 'rejected',
      code: 'E_MIGRATION_OPERATION_ID_REUSED',
      authorityChanged: false,
    };
  }
  const edge = edges(contract).find((entry) => entry.id === request.edgeId);
  if (!edge)
    return {
      status: 'rejected',
      code: 'E_MIGRATION_UNSUPPORTED_EDGE',
      authorityChanged: false,
    };
  if (
    request.sourceProtocol === edge.to &&
    request.targetProtocol === edge.from
  )
    return {
      status: 'rejected',
      code: 'E_MIGRATION_DOWNGRADE_REFUSED',
      authorityChanged: false,
    };
  if (
    request.sourceProtocol !== edge.from ||
    request.targetProtocol !== edge.to
  )
    return {
      status: 'rejected',
      code: 'E_MIGRATION_UNSUPPORTED_EDGE',
      authorityChanged: false,
    };
  if (!SHA256_ROOT.test(String(request.sourceRoot || '')))
    return {
      status: 'rejected',
      code: 'E_MIGRATION_SOURCE_ROOT_INVALID',
      authorityChanged: false,
    };
  if (
    !SHA256_ROOT.test(String(request.successorRoot || '')) ||
    request.successorRoot === request.sourceRoot
  )
    return {
      status: 'rejected',
      code: 'E_MIGRATION_EVIDENCE_MISSING',
      authorityChanged: false,
    };
  const evidenceRoots = Array.isArray(request.sourceEvidenceRoots)
    ? request.sourceEvidenceRoots.map(String)
    : [];
  if (
    evidenceRoots.length === 0 ||
    evidenceRoots.some((root) => !SHA256_ROOT.test(root))
  )
    return {
      status: 'rejected',
      code: 'E_MIGRATION_EVIDENCE_MISSING',
      authorityChanged: false,
    };
  const transformationEvidenceRoots = Array.isArray(
    request.transformationEvidenceRoots,
  )
    ? request.transformationEvidenceRoots.map(String)
    : [];
  if (
    transformationEvidenceRoots.length === 0 ||
    transformationEvidenceRoots.some((root) => !SHA256_ROOT.test(root))
  )
    return {
      status: 'rejected',
      code: 'E_MIGRATION_EVIDENCE_MISSING',
      authorityChanged: false,
    };
  assert.notEqual(
    request.successorRoot,
    request.sourceRoot,
    'semantic migration must not relabel the source root',
  );
  const transformationEvidenceRoot = contentRoot(transformationEvidenceRoots);
  const receipt = {
    schema: 'kungfu.format-migration.receipt/v1',
    operationId,
    requestRoot,
    edgeId: edge.id,
    sourceProtocol: edge.from,
    targetProtocol: edge.to,
    sourceRoot: request.sourceRoot,
    successorRoot: request.successorRoot,
    sourceEvidenceRoots: evidenceRoots,
    transformationEvidenceRoots,
    transformationEvidenceRoot,
    identityEffect: 'successor',
  };
  return {
    status: 'successor-receipt-projected',
    receipt,
    authorityChanged: false,
  };
}

/**
 * @param {{
 *   operationId: string,
 *   sourceRoot: string,
 *   damageEvidenceRoots?: string[],
 *   replacementEvidenceRoots?: string[],
 *   recoveredRanges?: string[],
 *   unrecoveredRanges?: string[],
 *   semanticsProved?: boolean
 * }} request
 */
export function planEvidencePreservingRepair(request) {
  const damageEvidenceRoots = request.damageEvidenceRoots || [];
  if (
    damageEvidenceRoots.length === 0 ||
    damageEvidenceRoots.some((root) => !SHA256_ROOT.test(root))
  )
    return {
      status: 'rejected',
      code: 'E_REPAIR_DAMAGE_EVIDENCE_MISSING',
      authorityChanged: false,
    };
  if (!request.semanticsProved)
    return {
      status: 'rejected',
      code: 'E_REPAIR_SEMANTIC_RECOVERY_UNPROVEN',
      authorityChanged: false,
      damageEvidenceRoots,
    };
  const replacementEvidenceRoots = request.replacementEvidenceRoots || [];
  if (
    replacementEvidenceRoots.length === 0 ||
    replacementEvidenceRoots.some((root) => !SHA256_ROOT.test(root))
  )
    return {
      status: 'rejected',
      code: 'E_MIGRATION_EVIDENCE_MISSING',
      authorityChanged: false,
      damageEvidenceRoots,
    };
  const successorRoot = contentRoot({
    schema: 'kungfu.format-repair.successor/v1',
    sourceRoot: request.sourceRoot,
    damageEvidenceRoots,
    replacementEvidenceRoots,
    recoveredRanges: request.recoveredRanges || [],
    unrecoveredRanges: request.unrecoveredRanges || [],
  });
  return {
    status: 'successor-planned',
    authorityChanged: false,
    receipt: {
      schema: 'kungfu.format-repair.receipt/v1',
      operationId: request.operationId,
      sourceRoot: request.sourceRoot,
      successorRoot,
      damageEvidenceRoots,
      replacementEvidenceRoots,
      recoveredRanges: request.recoveredRanges || [],
      unrecoveredRanges: request.unrecoveredRanges || [],
      identityEffect: 'successor',
    },
  };
}

/**
 * @param {Record<string, unknown>} contract
 * @param {{root?: string, readSource?: (relative: string) => string}} [options]
 */
export function validateFormatMigrationContract(contract, options = {}) {
  const root = options.root || ROOT;
  const readSource =
    options.readSource ||
    ((relative) => fs.readFileSync(path.join(root, relative), 'utf8'));
  /** @type {string[]} */
  const issues = [];
  const fail = (message) => issues.push(message);
  if (
    contract.schema !== 'kungfu.format-migration.contract/v1' ||
    contract.id !== 'kungfu-format-migration' ||
    contract.version !== 1
  )
    fail('format migration contract identity drifted');
  const tuple = isObject(contract.compatibilityTuple)
    ? contract.compatibilityTuple
    : {};
  const axes = Array.isArray(tuple.requiredAxes)
    ? tuple.requiredAxes.map(String)
    : [];
  for (const axis of [
    'journalEpoch',
    'workspaceLayout',
    'recordSchemas',
    'payloadSchemas',
    'rootProtocols',
    'bundleManifest',
    'capabilities',
  ])
    if (!axes.includes(axis)) fail(`missing compatibility axis: ${axis}`);
  if (tuple.semverRole !== 'display-and-package-pickup-only')
    fail('semver became a compatibility algorithm');

  const graph = isObject(contract.migrationGraph)
    ? contract.migrationGraph
    : {};
  if (graph.directed !== true || graph.implicitReverseEdges !== false)
    fail('migration graph must remain directed with no implicit reverse edges');
  for (const edge of edges(contract)) {
    if (
      !edge.id ||
      !edge.axis ||
      !edge.from ||
      !edge.to ||
      edge.from === edge.to
    )
      fail('migration edge identity is incomplete');
    if (
      edge.mode !== 'explicit-cold-path' ||
      edge.identityEffect !== 'successor'
    )
      fail(`${edge.id || '<unknown>'} bypasses the cold successor boundary`);
  }
  const repair = isObject(contract.repair) ? contract.repair : {};
  if (!String(repair.evidenceRule || '').includes('never deletes or rewrites'))
    fail('repair no longer preserves damage evidence');
  const status = isObject(contract.status) ? contract.status : {};
  if (status.realWorkspaceMutation !== 'not-implemented')
    fail('contract unexpectedly claims real workspace mutation');

  const bindings = isObject(contract.implementationBindings)
    ? contract.implementationBindings
    : {};
  for (const [bindingId, raw] of Object.entries(bindings)) {
    const binding = isObject(raw) ? raw : {};
    const source = String(binding.source || '');
    let sourceText = '';
    try {
      sourceText = readSource(source);
    } catch {
      fail(`${bindingId} binding source is missing: ${source}`);
      continue;
    }
    for (const [key, marker] of Object.entries(binding))
      if (
        key !== 'source' &&
        typeof marker === 'string' &&
        !sourceText.includes(marker)
      )
        fail(`${bindingId} binding marker drifted: ${marker}`);
  }

  const current = isObject(contract.currentTuple) ? contract.currentTuple : {};
  if (tupleIssues(contract, current).length)
    fail('current compatibility tuple is incomplete');
  const exact = negotiateFormat(contract, { source: current });
  if (exact.readerOutcome !== 'read' || exact.authorityChanged)
    fail('exact tuple negotiation drifted');
  return issues;
}

export function checkFormatMigrationContract(root = ROOT) {
  const contract = JSON.parse(
    fs.readFileSync(path.join(root, CONTRACT_PATH), 'utf8'),
  );
  const issues = validateFormatMigrationContract(contract, { root });
  if (issues.length)
    throw new Error(
      `format migration contract drift:\n- ${issues.join('\n- ')}`,
    );
  return {
    contract: CONTRACT_PATH,
    axes: contract.compatibilityTuple.requiredAxes.length,
    edges: contract.migrationGraph.edges.length,
    errors: contract.errorDictionary.length,
  };
}

function main() {
  const result = checkFormatMigrationContract();
  console.log(
    `[format-migration] contract=${result.contract} axes=${result.axes} edges=${result.edges} errors=${result.errors}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    main();
  } catch (error) {
    console.error(
      `[format-migration] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
