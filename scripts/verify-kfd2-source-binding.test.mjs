// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));

test('release verification binds KFD-2 claims to the canonical prebuild witness', () => {
  const verify = fs.readFileSync(path.join(ROOT, 'scripts/verify.mjs'), 'utf8');
  const witness = readJson(
    '.buildchain/kfd/kfd-3/collaboration-interface.prebuild.json',
  );
  const releaseClaims = readJson('.buildchain/kfd/kfd-2/release-claims.json');

  assert.match(
    verify,
    /const kfd2SourceSha = kfd3PrebuildWitness\?\.source\?\.sourceSha/,
  );
  assert.match(verify, /'--source-sha',\s*kfd2SourceSha/);
  assert.match(verify, /KFD-2 release claims check requires source\.sourceSha/);
  assert.equal(releaseClaims.release.sourceSha, witness.source.sourceSha);
});

test('release workflows publish the complete canonical KFD-2 claim set', () => {
  const workflow = fs.readFileSync(
    path.join(ROOT, '.github/workflows/release-new-version.yml'),
    'utf8',
  );
  const releaseClaims = readJson('.buildchain/kfd/kfd-2/release-claims.json');
  const expectedPaths = releaseClaims.claims
    .map(({ id }) => `.buildchain/kfd/kfd-2/claims/${id}.json`)
    .sort();
  const claimBlocks = [
    ...workflow.matchAll(
      /release-passport-kfd-2-claim-jsons: \|\n((?:\s+\.buildchain\/kfd\/kfd-2\/claims\/[^\n]+\.json\n?)+)/g,
    ),
  ];

  assert.equal(claimBlocks.length, 2);
  for (const [, block] of claimBlocks) {
    const actualPaths = block
      .trim()
      .split('\n')
      .map((entry) => entry.trim())
      .sort();
    assert.deepEqual(actualPaths, expectedPaths);
    for (const relativePath of actualPaths) {
      assert.equal(fs.existsSync(path.join(ROOT, relativePath)), true);
    }
  }
});
