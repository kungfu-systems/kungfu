// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT_PATH,
  executeReferenceMigration,
  negotiateFormat,
  planEvidencePreservingRepair,
  validateFormatMigrationContract,
} from './check-format-migration-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  fs.readFileSync(path.join(ROOT, CONTRACT_PATH), 'utf8'),
);
const root = (digit) => `sha256:${digit.repeat(64)}`;

test('accepts the repository migration authority', () => {
  assert.deepEqual(
    validateFormatMigrationContract(contract, { root: ROOT }),
    [],
  );
});

test('compares the complete tuple instead of package semver', () => {
  const result = negotiateFormat(contract, {
    source: structuredClone(contract.currentTuple),
  });
  assert.equal(result.readerOutcome, 'read');
  assert.equal(result.reason, 'FORMAT_EXACT');
  assert.equal(result.authorityChanged, false);
});

test('selects only the declared forward cold-path edge', () => {
  const source = structuredClone(contract.currentTuple);
  source.rootProtocols.factRoot = 'sha256-length-framed-fields-v1';
  const result = negotiateFormat(contract, { source });
  assert.equal(result.readerOutcome, 'migration-required');
  assert.equal(result.edgeId, 'fact-root-v1-to-v2');
  assert.equal(result.authorityChanged, false);
});

test('preserves optional unknown capabilities as degraded, not exact', () => {
  const source = structuredClone(contract.currentTuple);
  source.capabilities.push('future-optional-inspection');
  const result = negotiateFormat(contract, { source });
  assert.equal(result.readerOutcome, 'read-degraded');
  assert.equal(result.reason, 'FORMAT_OPTIONAL_UNKNOWN');
  assert.deepEqual(result.optionalUnknownCapabilities, [
    'future-optional-inspection',
  ]);
  assert.equal(result.authorityChanged, false);
});

test('refuses downgrade and unsupported graph edges before writes', () => {
  const downgradeTarget = structuredClone(contract.currentTuple);
  downgradeTarget.rootProtocols.factRoot = 'sha256-length-framed-fields-v1';
  const downgrade = negotiateFormat(contract, {
    source: contract.currentTuple,
    target: downgradeTarget,
  });
  assert.equal(downgrade.code, 'E_MIGRATION_DOWNGRADE_REFUSED');
  assert.equal(downgrade.authorityChanged, false);

  const unsupported = structuredClone(contract.currentTuple);
  unsupported.journalEpoch = 'kungfu.journal.container/future';
  const result = negotiateFormat(contract, { source: unsupported });
  assert.equal(result.code, 'E_MIGRATION_UNSUPPORTED_EDGE');
  assert.equal(result.authorityChanged, false);
});

test('creates a receipt-bound successor without relabeling the source', () => {
  const request = {
    operationId: 'migration:test:1',
    edgeId: 'fact-root-v1-to-v2',
    sourceProtocol: 'sha256-length-framed-fields-v1',
    targetProtocol: 'kungfu.fact-root.canonical/v2',
    sourceRoot: root('1'),
    successorRoot: root('e'),
    sourceEvidenceRoots: [root('2')],
    transformationEvidenceRoots: [root('f')],
  };
  const result = executeReferenceMigration(contract, request);
  assert.equal(result.status, 'successor-receipt-projected');
  assert.equal(result.authorityChanged, false);
  assert.notEqual(result.receipt.successorRoot, request.sourceRoot);
  assert.deepEqual(result.receipt.sourceEvidenceRoots, [root('2')]);
  assert.deepEqual(result.receipt.transformationEvidenceRoots, [root('f')]);
});

test('retries idempotently and reconciles outcome unknown exactly', () => {
  const request = {
    operationId: 'migration:test:2',
    edgeId: 'fact-root-v1-to-v2',
    sourceProtocol: 'sha256-length-framed-fields-v1',
    targetProtocol: 'kungfu.fact-root.canonical/v2',
    sourceRoot: root('3'),
    successorRoot: root('e'),
    sourceEvidenceRoots: [root('4')],
    transformationEvidenceRoots: [root('f')],
  };
  const first = executeReferenceMigration(contract, request);
  const retried = executeReferenceMigration(contract, request, [first.receipt]);
  assert.equal(retried.status, 'reconciled');
  assert.deepEqual(retried.receipt, first.receipt);
  assert.equal(retried.authorityChanged, false);

  const changed = executeReferenceMigration(
    contract,
    { ...request, sourceRoot: root('5') },
    [first.receipt],
  );
  assert.equal(changed.code, 'E_MIGRATION_OPERATION_ID_REUSED');
  assert.equal(changed.authorityChanged, false);
});

test('refuses reverse execution even when the edge id is known', () => {
  const result = executeReferenceMigration(contract, {
    operationId: 'migration:test:reverse',
    edgeId: 'fact-root-v1-to-v2',
    sourceProtocol: 'kungfu.fact-root.canonical/v2',
    targetProtocol: 'sha256-length-framed-fields-v1',
    sourceRoot: root('6'),
    successorRoot: root('e'),
    sourceEvidenceRoots: [root('7')],
    transformationEvidenceRoots: [root('f')],
  });
  assert.equal(result.code, 'E_MIGRATION_DOWNGRADE_REFUSED');
  assert.equal(result.authorityChanged, false);
});

test('repair retains damage evidence in a successor receipt', () => {
  const result = planEvidencePreservingRepair({
    operationId: 'repair:test:1',
    sourceRoot: root('8'),
    damageEvidenceRoots: [root('9')],
    replacementEvidenceRoots: [root('a')],
    recoveredRanges: ['0:32'],
    unrecoveredRanges: ['32:40'],
    semanticsProved: true,
  });
  assert.equal(result.status, 'successor-planned');
  assert.equal(result.authorityChanged, false);
  assert.deepEqual(result.receipt.damageEvidenceRoots, [root('9')]);
  assert.notEqual(result.receipt.successorRoot, root('8'));
});

test('structural evidence cannot invent semantic recovery', () => {
  const result = planEvidencePreservingRepair({
    operationId: 'repair:test:2',
    sourceRoot: root('b'),
    damageEvidenceRoots: [root('c')],
    replacementEvidenceRoots: [root('d')],
    semanticsProved: false,
  });
  assert.equal(result.code, 'E_REPAIR_SEMANTIC_RECOVERY_UNPROVEN');
  assert.equal(result.authorityChanged, false);
  assert.deepEqual(result.damageEvidenceRoots, [root('c')]);
});

test('validation rejects semver compatibility and hidden reverse edges', () => {
  const changed = structuredClone(contract);
  changed.compatibilityTuple.semverRole = 'compatibility-authority';
  changed.migrationGraph.implicitReverseEdges = true;
  const issues = validateFormatMigrationContract(changed, { root: ROOT });
  assert.ok(issues.some((issue) => issue.includes('semver')));
  assert.ok(issues.some((issue) => issue.includes('implicit reverse')));
});
