#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

// Product documentation qualification reads Atlas bodies, which ADR-0130
// keeps as local material rather than tracked bytes. This lane first
// re-verifies the tracked witness chain (which fails closed on drifted
// material), then runs the body-dependent tests exactly when the selected
// baseline material is present and otherwise records an explicit witness-only
// deferral, so the lane decision is auditable rather than a silent skip.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MATERIAL_TESTS = [
  path.join('scripts', 'documentation-product-pack.test.mjs'),
  path.join('scripts', 'shifu-documentation-qualification.test.mjs'),
];

export function selectedBaselineMaterialized(root = ROOT) {
  const selector = JSON.parse(
    fs.readFileSync(
      path.join(root, '.xinfa', 'product-documentation-pack.json'),
      'utf8',
    ),
  );
  const baseline = path.join(
    root,
    '.xinfa',
    'baselines',
    'sha256',
    selector.atlasRoot.slice('sha256:'.length),
  );
  return fs.existsSync(path.join(baseline, 'atlas.json'));
}

function main() {
  const witness = spawnSync(
    process.execPath,
    [path.join('scripts', 'buildchain-documentation-witness.mjs'), '--check'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (witness.status !== 0) process.exit(witness.status ?? 1);
  if (!selectedBaselineMaterialized()) {
    console.log(
      '[docs-material] witness-only checkout: selected Atlas material is absent; body-dependent product qualification defers to the materialized lane (ADR-0130)',
    );
    return;
  }
  const result = spawnSync(process.execPath, ['--test', ...MATERIAL_TESTS], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
