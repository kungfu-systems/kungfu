#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const ORACLE_FILES = new Set([
  'crates/xinfa/README.md',
  'crates/xinfa/tooling/standalone-smoke.mjs',
  'crates/xinfa/tooling/dogfood.mjs',
  'scripts/verify-kfd-owned-fixtures.mjs',
  'scripts/check-project-cut-settlement-integration.test.mjs',
]);
const PHYSICAL = /(?:xinfa[\\/])?target[\\/]debug[\\/]xinfa(?:\.exe)?/g;
const CONSTRUCTED = /['"]xinfa['"]\s*,\s*['"]target['"]\s*,\s*['"]debug['"]/g;

/** @param {string} relative @param {string} source */
export function scanSourceEntry(relative, source) {
  if (
    ORACLE_FILES.has(relative) ||
    relative.startsWith('.xinfa/baselines/') ||
    /\.test\.[cm]?js$/u.test(relative)
  )
    return [];
  const findings = [];
  for (const pattern of [PHYSICAL, CONSTRUCTED]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern))
      findings.push({
        file: relative,
        offset: match.index,
        source: match[0],
      });
  }
  return findings;
}

export function checkSourceEntries(root = ROOT) {
  const listed = spawnSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  });
  if (listed.error || listed.status !== 0)
    throw new Error(
      `git ls-files failed: ${listed.error?.message || listed.stderr}`,
    );
  return listed.stdout
    .split('\0')
    .filter(Boolean)
    .flatMap((relative) => {
      const file = path.join(root, relative);
      if (!fs.statSync(file).isFile()) return [];
      return scanSourceEntry(relative, fs.readFileSync(file, 'utf8'));
    });
}

function main() {
  const findings = checkSourceEntries();
  if (!findings.length) {
    console.log('[xinfa] production callers use the source-bound entry');
    return;
  }
  for (const finding of findings)
    console.error(
      `${finding.file}: physical Xinfa binary reference: ${finding.source}`,
    );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
