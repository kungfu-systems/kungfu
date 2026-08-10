// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { verifyAlphaReleaseCutLock } from './verify-alpha-release-cut-lock.mjs';

const ROOT = process.cwd();

test('Alpha.2 r16 lock verifies the exact Release Cut and fixed runtimes', () => {
  const result = verifyAlphaReleaseCutLock({ root: ROOT });
  assert.equal(result.ok, true);
  assert.equal(result.release, 'v4.0.0-alpha.2');
  assert.equal(result.cut, 'r16');
  assert.equal(result.candidateSettlementAuthorized, false);
});

test('Alpha.2 r16 lock keeps Buildchain invocation floating', () => {
  const build = fs.readFileSync(
    path.join(ROOT, '.github/workflows/build.yml'),
    'utf8',
  );
  const promotion = fs.readFileSync(
    path.join(ROOT, '.github/workflows/release-new-version.yml'),
    'utf8',
  );
  assert.match(
    build,
    /uses: kungfu-systems\/buildchain\/\.github\/workflows\/\.build\.yml@v3/u,
  );
  assert.match(
    build,
    /buildchain-ref: \$\{\{ inputs\.buildchain-ref \|\| 'v3' \}\}/u,
  );
  assert.match(
    promotion,
    /buildchain-ref: \$\{\{ startsWith\(inputs\.target-ref \|\| github\.event\.pull_request\.base\.ref, 'alpha\/'\) && 'v3-alpha' \|\| 'v3' \}\}/u,
  );
  assert.doesNotMatch(build, /\.github\/workflows\/\.build\.yml@[0-9a-f]{40}/u);
});

test('candidate patrol verifies the frozen cut without settling from moving dev', () => {
  const patrol = fs.readFileSync(
    path.join(ROOT, '.github/workflows/dev-alpha-candidate-patrol.yml'),
    'utf8',
  );
  assert.match(patrol, /name: Verify frozen Alpha Release Cut source lock/u);
  assert.match(
    patrol,
    /\.\/shifu node scripts\/verify-alpha-release-cut-lock\.mjs/u,
  );
  assert.match(
    patrol,
    /needs\.release-cut-lock\.outputs\.candidate-settlement-authorized == 'true'/u,
  );
});
