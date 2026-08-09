#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureNativeFinding } from '../dogfood/native-finding-capture.mjs';

const CLASSIFICATION_SCHEMA = 'kungfu.agent-patrol.classification/v1';
const FINDING_INTENT_SCHEMA = 'kungfu.agent-patrol.finding-intent/v1';
const RECEIPT_SCHEMA = 'kungfu.agent-patrol.dogfood-capture-receipt/v1';
const ROOT_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function validateClassification(value) {
  if (value?.schema !== CLASSIFICATION_SCHEMA)
    throw new Error('Patrol classification schema is unsupported');
  if (value.issueAdmission !== 'prohibited')
    throw new Error('Patrol classification must prohibit Issue admission');
  if (typeof value.captureRequired !== 'boolean')
    throw new Error('Patrol captureRequired must be boolean');
  if (!value.captureRequired) return;
  const intent = value.findingIntent;
  if (
    intent?.schema !== FINDING_INTENT_SCHEMA ||
    intent.findingId !== intent.capture?.findingId
  )
    throw new Error('Patrol Finding intent is invalid');
  if (!ROOT_PATTERN.test(intent.fingerprintRoot || ''))
    throw new Error('Patrol Finding fingerprint root is invalid');
  for (const forbidden of [
    'issueId',
    'owner',
    'findingRoots',
    'verificationCriteria',
  ])
    if (Object.hasOwn(intent.capture, forbidden))
      throw new Error(
        `Patrol Finding intent contains forbidden field ${forbidden}`,
      );
}

function boundedReceipt({
  status,
  findingId = null,
  findingRoot = null,
  lookupRoot = null,
  nativeStatus = null,
  capturePerformed = false,
  runtimeReceipt = null,
  runtimeVerification = null,
}) {
  return {
    schema: RECEIPT_SCHEMA,
    status,
    findingId,
    findingRoot,
    lookupRoot,
    nativeStatus,
    capturePerformed,
    issueAdmitted: false,
    runtimeReceipt,
    runtimeVerification,
  };
}

export function captureFinding(
  classification,
  { run, intentPath, workspaceRoot, inspectSource },
) {
  validateClassification(classification);
  if (!classification.captureRequired)
    return boundedReceipt({ status: 'not-required' });
  if (!path.isAbsolute(workspaceRoot || ''))
    throw new Error('Patrol Dogfood workspace must be an absolute path');

  const captured = captureNativeFinding(classification.findingIntent, {
    ...(run ? { run } : {}),
    ...(inspectSource ? { inspectSource } : {}),
    intentPath,
    workspaceRoot,
    authorizedBy: 'agent-patrol-agent-121',
    reason: 'agent-patrol-dogfood-finding',
  });
  return boundedReceipt({
    ...captured,
  });
}

export function parseArgs(argv) {
  const result = {
    classification: '',
    output: '',
    intent: '',
    workspace: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--classification') result.classification = argv[++index] || '';
    else if (arg === '--output') result.output = argv[++index] || '';
    else if (arg === '--intent') result.intent = argv[++index] || '';
    else if (arg === '--workspace') result.workspace = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of Object.keys(result))
    if (!result[field]) throw new Error(`--${field} is required`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const classification = JSON.parse(
      fs.readFileSync(options.classification, 'utf8'),
    );
    const receipt = captureFinding(classification, {
      intentPath: options.intent,
      workspaceRoot: path.resolve(options.workspace),
    });
    fs.mkdirSync(path.dirname(path.resolve(options.output)), {
      recursive: true,
    });
    fs.writeFileSync(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        status: receipt.status,
        findingId: receipt.findingId,
        findingRoot: receipt.findingRoot,
        issueAdmitted: false,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  }
}
