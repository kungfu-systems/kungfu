#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  compositionChanged,
  observeComposition,
  verifyComposition,
} from '../framework/project-cut/src/composition.mjs';
import { devMergeBaseCandidates } from './candidate-timeline-events.cjs';
import { sourceMergeGroupBase } from './source-acceptance.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function git(args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.status === 0 ? result.stdout.trim() : '';
}
export function resolveCompositionBase({
  mergeGroupBase = sourceMergeGroupBase,
  candidates = devMergeBaseCandidates,
  gitRead = git,
} = {}) {
  const exactMergeGroupBase = mergeGroupBase();
  if (exactMergeGroupBase) return exactMergeGroupBase.sha;
  return candidates()
    .map((ref) => gitRead(['merge-base', ref, 'HEAD']))
    .find(Boolean);
}

function main() {
  const base = resolveCompositionBase();
  if (!base) {
    console.error('[project-cut-composition] cannot resolve merge base');
    process.exit(1);
  }
  if (!compositionChanged(root, base, 'HEAD')) {
    console.log(
      '[project-cut-composition] no changed Cut manifests; scoped gate skipped',
    );
    return;
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
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
