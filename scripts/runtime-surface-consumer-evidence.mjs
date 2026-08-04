#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

export function valueRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

export function consumerEvidence({
  rowId,
  consumer,
  output,
  receipts,
  observers = [],
}) {
  if (!rowId || !consumer || output === undefined || !receipts.length)
    fail('row, consumer, probe output, and at least one receipt are required');
  const probe = {
    schema: 'kungfu.runtime-surface-consumer-probe/v1',
    ok: true,
    output,
    outputRoot: valueRoot(output),
    observers: [...new Set(observers)].sort(),
  };
  const body = {
    schema: 'kungfu.runtime-surface-consumer-evidence/v1',
    rowId,
    consumer,
    probe,
    receipts,
  };
  return { ...body, evidenceRoot: valueRoot(body) };
}

function parseArgs(argv) {
  const options = {
    row: '',
    consumer: '',
    probeOutput: '',
    receipts: [],
    observers: [],
    output: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--row') options.row = argv[++index] || '';
    else if (arg === '--consumer') options.consumer = argv[++index] || '';
    else if (arg === '--probe-output')
      options.probeOutput = argv[++index] || '';
    else if (arg === '--receipt') options.receipts.push(argv[++index] || '');
    else if (arg === '--observer') options.observers.push(argv[++index] || '');
    else if (arg === '--output') options.output = argv[++index] || '';
    else fail(`unknown argument: ${arg}`);
  }
  for (const field of ['row', 'consumer', 'probeOutput', 'output'])
    if (!options[field])
      fail(
        `--${field.replace(/[A-Z]/gu, (char) => `-${char.toLowerCase()}`)} is required`,
      );
  if (!options.receipts.length) fail('--receipt is required');
  return options;
}

function readObject(file, label) {
  const value = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must contain one JSON object`);
  return value;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const evidence = consumerEvidence({
      rowId: options.row,
      consumer: options.consumer,
      output: readObject(options.probeOutput, 'probe output'),
      receipts: options.receipts.map((file) => readObject(file, 'receipt')),
      observers: options.observers,
    });
    const output = path.resolve(options.output);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: 'wx',
    });
    process.stdout.write(
      `${JSON.stringify({
        schema: evidence.schema,
        rowId: evidence.rowId,
        evidenceRoot: evidence.evidenceRoot,
        output,
      })}\n`,
    );
  } catch (error) {
    process.stderr.write(`runtime surface evidence failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
