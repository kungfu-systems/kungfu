// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  compilePortableBundle,
  portableClassificationPaths,
  verifyPortableBundle,
} from './portable-atlas-bundle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('portable bundle closes classifications, routes, and bounded bytes', () => {
  const manifest = compilePortableBundle();
  const selector = JSON.parse(
    fs.readFileSync(
      path.join(ROOT, '.xinfa/product-documentation-pack.json'),
      'utf8',
    ),
  );
  assert.equal(manifest.sourceCut.commit, selector.materialSource.originCommit);
  assert.equal(manifest.sourceCut.tree, selector.materialSource.originTree);
  assert.equal(manifest.classification.unknown, 0);
  assert.equal(manifest.classification.silentOmissions, 0);
  assert.equal(manifest.routes.incompleteRoutes, 0);
  assert.ok(manifest.routes.routeCount >= 30);
  assert.equal(manifest.budgets.passed, true);
  assert.equal(manifest.assembly.policy, 'identical-bundle-root');
  assert.equal(verifyPortableBundle(manifest).valid, true);
});

test('portable bundle root fails closed on tamper', () => {
  const manifest = compilePortableBundle();
  manifest.budgets.metrics.compressedBytes += 1;
  const receipt = verifyPortableBundle(manifest);
  assert.equal(receipt.valid, false);
  assert.ok(receipt.diagnostics.some((row) => row.code === 'bundle-root'));
});

test('content-addressed control proofs retain one stable classification', () => {
  const baseline = portableClassificationPaths(['README.md']);
  const withProofs = portableClassificationPaths([
    'README.md',
    `framework/site/src/kfx-site-impact-proofs/${'1'.repeat(64)}.json`,
    `framework/site/src/kfx-site-impact-proofs/${'2'.repeat(64)}.json`,
  ]);
  assert.deepEqual(withProofs, baseline);
  assert.ok(baseline.includes('framework/site/src/kfx-site-impact-proofs/'));
});

test('active product surfaces do not retain the retired clone command', () => {
  for (const relative of [
    'crates/shifu/src/main.rs',
    'crates/shifu/agent/brief.md',
    'crates/shifu/agent/intent-map.json',
    'docs/development/rust-adoption.md',
  ]) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.doesNotMatch(source, /shifu clone/u, relative);
  }
});
