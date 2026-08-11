// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const LOCK = JSON.parse(
  fs.readFileSync(
    path.join(ROOT, '.buildchain/alpha-release-cut-lock.json'),
    'utf8',
  ),
);

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

test('Alpha.2 r17 lock verifies the exact Release Cut and fixed runtimes', () => {
  assert.equal(LOCK.schema, 'kungfu.alpha-release-cut-lock/v1');
  assert.equal(LOCK.release, 'v4.0.0-alpha.2');
  assert.equal(LOCK.cut, 'r17');
  assert.equal(LOCK.state, 'frozen');
  assert.equal(LOCK.candidate.sha, '77a66f7141143e524484a548dbba76a1ae1ecc38');
  assert.equal(LOCK.alphaBase.sha, 'f9e6b0e34bcdd6407b2a18206ace7982d64de2c8');
  assert.equal(
    git('show', '-s', '--format=%P', LOCK.candidate.sha),
    LOCK.lineage.parentOrder.join(' '),
  );
  assert.equal(
    git('rev-parse', `${LOCK.candidate.sha}^{tree}`),
    LOCK.candidate.tree,
  );
  assert.equal(git('rev-parse', `${LOCK.devCut.sha}^{tree}`), LOCK.devCut.tree);
  assert.equal(
    git('rev-parse', `${LOCK.alphaBase.sha}^{tree}`),
    LOCK.alphaBase.tree,
  );
  assert.equal(LOCK.candidate.tree, LOCK.devCut.tree);
  assert.deepEqual(LOCK.lineage.parentOrder, [
    LOCK.devCut.sha,
    LOCK.alphaBase.sha,
  ]);
  assert.equal(LOCK.policy.devMovementInvalidatesCut, false);
  assert.equal(LOCK.policy.devMirrorIsBuildInput, false);
  assert.equal(
    LOCK.policy.blockerRepairOrder,
    'release-cut-first-then-independent-dev-forward-port',
  );
});

test('Alpha.2 r17 lock keeps Buildchain invocation floating', () => {
  assert.equal(LOCK.buildchain.build.ref, 'v3');
  assert.equal(
    LOCK.buildchain.build.resolvedSha,
    'f4ca5182f53fddf76bdf4246be0993afa5a592bc',
  );
  assert.equal(
    LOCK.buildchain.build.contractDigest,
    'sha256:52cdb871cb0559534f78548f2487d8f3ceb64bb92e8a587f440a2946f78e7386',
  );
  assert.equal(LOCK.buildchain.promotion.ref, 'v3-alpha');
  assert.equal(
    LOCK.buildchain.promotion.resolvedSha,
    '36b08dc7bf417e57bffcc3dc784a2473254fe4c1',
  );
  assert.equal(
    LOCK.buildchain.promotion.contractDigest,
    'sha256:8e565f9ac5146d5dceafc3da6b267147fb412937db979bf35a0429966da82197',
  );
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
  assert.match(patrol, /lock=\.buildchain\/alpha-release-cut-lock\.json/u);
  assert.match(patrol, /git show -s --format=%P/u);
  assert.match(
    patrol,
    /needs\.release-cut-lock\.outputs\.candidate-settlement-authorized == 'true'/u,
  );
});
