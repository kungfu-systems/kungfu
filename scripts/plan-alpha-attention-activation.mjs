#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAlphaAttentionActivationPlan } from './alpha-attention-activation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  return [
    'Usage:',
    '  ./shifu alpha-attention:activation-plan -- --observed <state.json>',
    '',
    'The command reads normalized GitHub observation data and prints a',
    'deterministic, non-executable dry-run plan. It never contacts GitHub or',
    'changes live state. --execute is intentionally unsupported.',
  ].join('\n');
}

/** @param {string} pathname */
function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, 'utf8'));
}

/** @param {string[]} argv */
export function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    return { exitCode: 0, stdout: `${usage()}\n`, stderr: '' };
  }
  if (argv.includes('--execute')) {
    return {
      exitCode: 2,
      stdout: '',
      stderr:
        'alpha-attention:activation-plan is dry-run only; --execute is unsupported\n',
    };
  }
  const observedIndex = argv.indexOf('--observed');
  const observedPath =
    observedIndex >= 0 ? path.resolve(argv[observedIndex + 1] ?? '') : '';
  if (
    !observedPath ||
    !fs.existsSync(observedPath) ||
    !fs.statSync(observedPath).isFile()
  ) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: `${usage()}\n`,
    };
  }

  const operations = readJson(
    path.join(ROOT, '.github', 'alpha-attention-operations.json'),
  );
  const community = readJson(
    path.join(ROOT, '.github', 'community-health-baseline.json'),
  );
  const observed = readJson(observedPath);
  const plan = buildAlphaAttentionActivationPlan(
    operations,
    community,
    observed,
  );
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(plan, null, 2)}\n`,
    stderr: '',
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = run(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
