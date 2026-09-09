#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { captureNativeFinding } from '../dogfood/native-finding-capture.mjs';

const CLASSIFICATION_SCHEMA =
  'kungfu.dev-gate-latency-patrol.classification/v1';
const RECEIPT_SCHEMA =
  'kungfu.dev-gate-latency-patrol.dogfood-capture-receipt/v1';

export function captureLatencyFindings(
  value,
  { run, intentDirectory, workspaceRoot, inspectSource },
) {
  if (value?.schema !== CLASSIFICATION_SCHEMA)
    throw new Error('latency Patrol classification schema is unsupported');
  if (value.issueAdmission !== 'prohibited')
    throw new Error('latency Patrol must prohibit Issue admission');
  if (!value.captureRequired) {
    return {
      schema: RECEIPT_SCHEMA,
      status: 'not-required',
      receipts: [],
      issueAdmitted: false,
    };
  }
  if (
    !Array.isArray(value.findingIntents) ||
    value.findingIntents.length !== value.categories.length
  )
    throw new Error('latency Patrol Finding intents are incomplete');
  const receipts = value.findingIntents.map((intent) =>
    captureNativeFinding(intent, {
      ...(run ? { run } : {}),
      ...(inspectSource ? { inspectSource } : {}),
      intentPath: path.join(intentDirectory, `${intent.findingId}.json`),
      workspaceRoot,
      authorizedBy: 'dev-gate-latency-patrol-agent-121',
      reason: 'dev-gate-latency-patrol-finding',
    }),
  );
  return {
    schema: RECEIPT_SCHEMA,
    status: receipts.some(({ status }) => status === 'captured')
      ? 'captured'
      : 'deduplicated',
    receipts,
    issueAdmitted: false,
  };
}

export function parseArgs(argv) {
  const result = {
    classification: '',
    output: '',
    intentDirectory: '',
    workspace: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--classification') result.classification = argv[++index] || '';
    else if (arg === '--output') result.output = argv[++index] || '';
    else if (arg === '--intent-directory')
      result.intentDirectory = argv[++index] || '';
    else if (arg === '--workspace') result.workspace = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const field of Object.keys(result))
    if (!result[field])
      throw new Error(
        `--${field.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)} is required`,
      );
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const value = JSON.parse(fs.readFileSync(options.classification, 'utf8'));
    const receipt = captureLatencyFindings(value, {
      intentDirectory: path.resolve(options.intentDirectory),
      workspaceRoot: path.resolve(options.workspace),
    });
    fs.mkdirSync(path.dirname(path.resolve(options.output)), {
      recursive: true,
    });
    fs.writeFileSync(options.output, `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({
        status: receipt.status,
        findingCount: receipt.receipts.length,
        issueAdmitted: false,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 2;
  }
}
