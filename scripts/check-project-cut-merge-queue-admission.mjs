#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MERGE_QUEUE_ADMISSION_SCHEMA,
  inspectProjectCutMergeQueueAdmission,
} from './project-cut-merge-queue-admission.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error(
    'usage: ./shifu project-cut:queue-admission -- --base <ref> --head <ref>',
  );
}

function parseArgs(argv) {
  const values = argv[0] === '--' ? argv.slice(1) : [...argv];
  let base = '';
  let head = '';
  while (values.length > 0) {
    const option = values.shift();
    if (option === '--base') base = values.shift() ?? '';
    else if (option === '--head') head = values.shift() ?? '';
    else throw new Error(`unknown option: ${option}`);
  }
  if (!base || !head) throw new Error('--base and --head are required');
  return { base, head };
}

try {
  const { base, head } = parseArgs(process.argv.slice(2));
  const result = inspectProjectCutMergeQueueAdmission(root, base, head);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  usage();
  console.log(
    JSON.stringify({
      schema: MERGE_QUEUE_ADMISSION_SCHEMA,
      ok: false,
      decision: 'indeterminate',
      retryable: true,
      diagnostics: [
        {
          code: 'admission-infrastructure-error',
          path: '$',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      reasonCodes: ['admission-infrastructure-error'],
    }),
  );
  process.exitCode = 2;
}
