#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES =
  process.env.KUNGFU_DOCS_MODULES || path.join(ROOT, 'node_modules');

/** @param {string} label @param {string[]} args */
function run(label, args) {
  console.log(`[docs] ${label}`);
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.error) {
    throw new Error(
      `${label} could not start: ${result.error.code || result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status ?? result.signal})`);
  }
}

try {
  run('Markdown structure', [
    path.join(MODULES, 'markdownlint-cli2', 'markdownlint-cli2-bin.mjs'),
  ]);
  run('local links, anchors, and contracts', [
    path.join('scripts', 'check-docs.mjs'),
  ]);
  run('negative fixtures', [
    '--test',
    '--test-concurrency=1',
    path.join('scripts', 'adr-identity.test.mjs'),
    path.join('scripts', 'adr-new.test.mjs'),
    path.join('scripts', 'adr-audit.test.mjs'),
    path.join('scripts', 'adr-navigation.test.mjs'),
    path.join('scripts', 'adr-reference-links.test.mjs'),
    path.join('scripts', 'adr-release-gate.test.mjs'),
    path.join('scripts', 'release-promotion-rehearsal.test.mjs'),
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
  run('authored ADR reference links', [
    path.join('scripts', 'adr-reference-links.mjs'),
    '--check',
  ]);
  run('immutable documentation toolchain', [
    path.join('scripts', 'check-docs-toolchain.mjs'),
  ]);
  run('executable examples', [path.join('scripts', 'run-docs-examples.mjs')]);
  console.log('[docs] deterministic documentation gate passed');
} catch (error) {
  console.error(
    `[docs] ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
