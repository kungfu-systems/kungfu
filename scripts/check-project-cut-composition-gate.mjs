#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compositionChanged,
  observeComposition,
  verifyComposition,
} from '../framework/project-cut/src/composition.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function git(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}
const candidates = [
  process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : '',
  'origin/dev/v4/v4.0',
  'dev/v4/v4.0',
].filter(Boolean);
const base = candidates
  .map((ref) => git(['merge-base', ref, 'HEAD']))
  .find(Boolean);
if (!base) {
  console.error('[project-cut-composition] cannot resolve merge base');
  process.exit(1);
}
if (!compositionChanged(root, base, 'HEAD')) {
  console.log(
    '[project-cut-composition] no changed Cut manifests; scoped gate skipped',
  );
  process.exit(0);
}
const receipt = observeComposition(root, base, 'HEAD');
const verified = verifyComposition(root, receipt);
console.log(
  JSON.stringify({
    schema: 'project.cut.composition-gate/v1',
    ok: receipt.status === 'qualified' && verified.ok,
    compositionRoot: receipt.compositionRoot,
    changedCutRoots: receipt.scope.changedCutRoots,
    diagnostics: [...receipt.diagnostics, ...verified.diagnostics],
  }),
);
if (receipt.status !== 'qualified' || !verified.ok) process.exit(1);
