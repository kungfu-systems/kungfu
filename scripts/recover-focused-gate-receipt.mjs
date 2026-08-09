#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER = /KUNGFU_GATE_RECEIPT_BASE64=([A-Za-z0-9+/]+={0,2})(?=\s|$)/g;

export function recoverFocusedGateReceipt(log) {
  const encoded = [
    ...new Set([...log.matchAll(MARKER)].map((match) => match[1])),
  ];
  if (encoded.length === 0)
    throw new Error('focused Gate receipt marker is missing from the job log');
  if (encoded.length !== 1)
    throw new Error('job log contains multiple distinct focused Gate receipts');

  const receipt = Buffer.from(encoded[0], 'base64');
  let parsed;
  try {
    parsed = JSON.parse(receipt.toString('utf8'));
  } catch {
    throw new Error('focused Gate receipt marker does not contain valid JSON');
  }
  if (parsed?.schema !== 'shifu.gate-receipt/v1')
    throw new Error('focused Gate receipt has an unsupported schema');
  return receipt;
}

async function main() {
  const outputIndex = process.argv.indexOf('--output');
  const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : null;
  if (!output || process.argv.length !== 4)
    throw new Error('usage: recover-focused-gate-receipt.mjs --output PATH');

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const receipt = recoverFocusedGateReceipt(Buffer.concat(chunks).toString());
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, receipt);
  process.stderr.write(`[focused-receipt] recovered ${output}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    process.stderr.write(`[focused-receipt] ${error.message}\n`);
    process.exitCode = 1;
  });
}
