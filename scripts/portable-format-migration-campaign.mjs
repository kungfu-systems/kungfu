#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Disposable end-to-end proof for the cold-path migration and repair protocol.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  contentRoot,
  executeReferenceMigration,
  negotiateFormat,
  planEvidencePreservingRepair,
} from './check-format-migration-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, member]) => [key, canonical(member)]),
    );
  return value;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);
}

function writeRooted(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return sha256(bytes);
}

function statSnapshot(root) {
  const entries = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile())
        entries.push({
          path: path.relative(root, absolute).split(path.sep).join('/'),
          root: sha256(fs.readFileSync(absolute)),
        });
    }
  };
  walk(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export function runPortableFormatMigrationCampaign(repoRoot = ROOT) {
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(
        repoRoot,
        'framework/spec/format/kungfu-format-migration.contract.json',
      ),
      'utf8',
    ),
  );
  const workspace = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-portable-format-campaign-'),
  );
  try {
    const sourcePath = path.join(workspace, 'source', 'legacy.fact');
    const successorPath = path.join(workspace, 'successors', 'current.fact');
    const receiptPath = path.join(workspace, 'receipts', 'migration.json');
    const sourceBytes = Buffer.from(
      'kungfu portable format disposable legacy source\n',
      'utf8',
    );
    const successorBytes = Buffer.from(
      'kungfu portable format disposable canonical successor\n',
      'utf8',
    );
    const sourceRoot = writeRooted(sourcePath, sourceBytes);
    const successorRoot = sha256(successorBytes);
    const initial = statSnapshot(workspace);

    const request = {
      operationId: 'portable-format-alpha-campaign:migration:1',
      edgeId: 'fact-root-v1-to-v2',
      sourceProtocol: 'sha256-length-framed-fields-v1',
      targetProtocol: 'kungfu.fact-root.canonical/v2',
      sourceRoot,
      successorRoot,
      sourceEvidenceRoots: [sourceRoot],
      transformationEvidenceRoots: [successorRoot],
    };
    const preview = executeReferenceMigration(contract, request);
    assert.equal(preview.status, 'successor-receipt-projected');
    assert.deepEqual(statSnapshot(workspace), initial);

    const noOp = negotiateFormat(contract, {
      source: structuredClone(contract.currentTuple),
    });
    assert.equal(noOp.readerOutcome, 'read');
    assert.deepEqual(statSnapshot(workspace), initial);

    const unsupportedTuple = structuredClone(contract.currentTuple);
    unsupportedTuple.workspaceLayout = 'kungfu.workspace.episode-layout/v99';
    const refusal = negotiateFormat(contract, { source: unsupportedTuple });
    assert.equal(refusal.code, 'E_MIGRATION_UNSUPPORTED_EDGE');
    assert.deepEqual(statSnapshot(workspace), initial);

    const interruptedStage = path.join(
      workspace,
      'staging',
      'interrupted.fact',
    );
    const interruptedRoot = writeRooted(interruptedStage, successorBytes);
    assert.equal(interruptedRoot, successorRoot);
    assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes);
    fs.unlinkSync(interruptedStage);
    assert.equal(fs.existsSync(interruptedStage), false);
    assert.deepEqual(fs.readFileSync(sourcePath), sourceBytes);

    const promotedStage = path.join(workspace, 'staging', 'promoted.fact');
    writeRooted(promotedStage, successorBytes);
    fs.mkdirSync(path.dirname(successorPath), { recursive: true });
    fs.renameSync(promotedStage, successorPath);
    writeRooted(receiptPath, jsonBytes(preview.receipt));
    assert.equal(sha256(fs.readFileSync(successorPath)), successorRoot);
    assert.equal(sha256(fs.readFileSync(sourcePath)), sourceRoot);

    const retry = executeReferenceMigration(contract, request, [
      preview.receipt,
    ]);
    assert.equal(retry.status, 'reconciled');
    assert.deepEqual(retry.receipt, preview.receipt);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(receiptPath, 'utf8')),
      preview.receipt,
    );

    const repairRefusal = planEvidencePreservingRepair({
      operationId: 'portable-format-alpha-campaign:repair:refused',
      sourceRoot,
      damageEvidenceRoots: [sourceRoot],
      replacementEvidenceRoots: [successorRoot],
      recoveredRanges: ['0:24'],
      unrecoveredRanges: ['24:48'],
      semanticsProved: false,
    });
    assert.equal(repairRefusal.code, 'E_REPAIR_SEMANTIC_RECOVERY_UNPROVEN');

    const repair = planEvidencePreservingRepair({
      operationId: 'portable-format-alpha-campaign:repair:1',
      sourceRoot,
      damageEvidenceRoots: [sourceRoot],
      replacementEvidenceRoots: [successorRoot],
      recoveredRanges: ['0:48'],
      unrecoveredRanges: [],
      semanticsProved: true,
    });
    assert.equal(repair.status, 'successor-planned');
    assert.notEqual(repair.receipt.successorRoot, sourceRoot);
    const repairReceiptPath = path.join(workspace, 'receipts', 'repair.json');
    writeRooted(repairReceiptPath, jsonBytes(repair.receipt));
    assert.equal(sha256(fs.readFileSync(sourcePath)), sourceRoot);

    const scenarios = [
      {
        id: 'preview',
        status: 'successor-receipt-projected',
        writeOccurred: false,
      },
      { id: 'no-op', status: 'read-current', writeOccurred: false },
      {
        id: 'unsupported-refusal',
        status: refusal.code,
        writeOccurred: false,
      },
      {
        id: 'interruption-recovery',
        status: 'unpromoted-stage-removed',
        writeOccurred: true,
        sourcePreserved: true,
      },
      {
        id: 'success',
        status: 'successor-and-receipt-admitted',
        writeOccurred: true,
        sourcePreserved: true,
        successorRoot,
      },
      {
        id: 'retry',
        status: 'exact-receipt-reconciled',
        writeOccurred: false,
        receiptRoot: contentRoot(preview.receipt),
      },
      {
        id: 'repair-refusal',
        status: repairRefusal.code,
        writeOccurred: false,
      },
      {
        id: 'repair-success',
        status: 'successor-receipt-admitted',
        writeOccurred: true,
        sourcePreserved: true,
        successorRoot: repair.receipt.successorRoot,
      },
    ];
    return {
      schema: 'kungfu.portable-format-migration-campaign-report/v1',
      boundary: 'disposable-temporary-workspace-only',
      sourceRoot,
      sourcePreserved: sha256(fs.readFileSync(sourcePath)) === sourceRoot,
      exactMigrationReceiptRoot: contentRoot(preview.receipt),
      finalInventoryRoot: contentRoot(statSnapshot(workspace)),
      scenarios,
    };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function main() {
  const report = runPortableFormatMigrationCampaign();
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  try {
    main();
  } catch (error) {
    console.error(
      `[portable-format-migration-campaign] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
