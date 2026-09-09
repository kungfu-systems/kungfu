#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKDOWNLINT = path.join(
  ROOT,
  'node_modules',
  'markdownlint-cli2',
  'markdownlint-cli2-bin.mjs',
);

/** @param {string} label @param {string[]} args */
function run(label, args) {
  console.log(`[docs:source] ${label}`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed: ${result.error?.message || result.status}`,
    );
  }
}

try {
  if (fs.existsSync(MARKDOWNLINT)) {
    run('Markdown structure', [MARKDOWNLINT]);
  } else {
    console.warn(
      '[docs:source] markdownlint-cli2 is not installed; repository documentation contracts still run, and CI enforces Markdown structure.',
    );
  }
  run('local links, anchors, and contracts', [
    path.join('scripts', 'check-docs.mjs'),
  ]);
  run('documentation contract fixtures', [
    '--test',
    '--test-concurrency=1',
    path.join('scripts', 'adr-identity.test.mjs'),
    path.join('scripts', 'adr-new.test.mjs'),
    path.join('scripts', 'adr-audit.test.mjs'),
    path.join('scripts', 'adr-navigation.test.mjs'),
    path.join('scripts', 'evolution-map.test.mjs'),
    path.join('scripts', 'adr-release-gate.test.mjs'),
    path.join('scripts', 'check-docs.test.mjs'),
    path.join('scripts', 'document-metadata-contract.test.mjs'),
    path.join('scripts', 'vocabulary-contract.test.mjs'),
    path.join('scripts', 'check-docs-toolchain.test.mjs'),
  ]);
  run('ADR release contract', [
    path.join('scripts', 'adr-release-gate.mjs'),
    '--contract-only',
  ]);
  run('ADR authority audit', [path.join('scripts', 'adr-audit.mjs')]);
  run('ADR human navigation projection', [
    path.join('scripts', 'adr-navigation.mjs'),
    '--check',
  ]);
  run('longitudinal evolution projections', [
    path.join('scripts', 'evolution-map', 'index.mjs'),
    '--check',
  ]);
  run('immutable documentation toolchain', [
    path.join('scripts', 'check-docs-toolchain.mjs'),
  ]);
  console.log('[docs:source] build-free documentation gate passed');
} catch (error) {
  console.error(
    `[docs:source] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
