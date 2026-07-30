#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs';

import {
  runOpenCardPreflight,
  verifyOpenCardPreflight,
} from '../src/work-design-open-card.mjs';

function inputPath(argv) {
  const index = argv.indexOf('--input');
  if (index < 0 || !argv[index + 1])
    throw new Error('usage: open-card-preflight --input <request.json>');
  return argv[index + 1];
}

try {
  const request = JSON.parse(fs.readFileSync(inputPath(process.argv), 'utf8'));
  const result = runOpenCardPreflight(request);
  const verification = verifyOpenCardPreflight(result);
  if (!verification.ok)
    throw new Error(`preflight verification failed: ${verification.reason}`);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
