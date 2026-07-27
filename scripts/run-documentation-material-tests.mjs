#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// @ts-check

// Product documentation qualification reads Atlas bodies, which KF-ADR-019f86da-4f90-7089-b9b1-e070edf7d540
// keeps out of the tracked baseline store. This lane first re-verifies the
// tracked witness chain, binds the selected public bytes directly to its exact
// content-addressed gzip bundle, then runs the body-dependent tests without
// restoring anything into the checkout.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATERIAL_TESTS = [
  path.join('scripts', 'documentation-product-pack.test.mjs'),
  path.join('scripts', 'shifu-documentation-qualification.test.mjs'),
];

export function documentationMaterialEnvironment(root = ROOT) {
  const selector = JSON.parse(
    fs.readFileSync(
      path.join(root, '.xinfa', 'product-documentation-pack.json'),
      'utf8',
    ),
  );
  const atlas = path.join(
    root,
    '.xinfa',
    'baselines',
    'sha256',
    selector.atlasRoot.slice('sha256:'.length),
  );
  const bundle = path.join(
    root,
    ...selector.materialSource.bundleRoot.split('/'),
  );
  return {
    KUNGFU_DOCUMENTATION_ATLAS: atlas,
    KUNGFU_DOCUMENTATION_ATLAS_BUNDLE: bundle,
  };
}

function main() {
  const witness = spawnSync(
    process.execPath,
    [path.join('scripts', 'buildchain-documentation-witness.mjs'), '--check'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  if (witness.status !== 0) process.exit(witness.status ?? 1);
  const result = spawnSync(process.execPath, ['--test', ...MATERIAL_TESTS], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...documentationMaterialEnvironment(),
    },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
