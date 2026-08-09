// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { sourceBinding } from './alpha-promotion-preflight.mjs';
import {
  buildAlphaPublicationTailPlan,
  findAlphaPublicationTailPlan,
  verifyAlphaPublicationTailPlan,
} from './alpha-publication-tail-plan.mjs';

const ROOT = process.cwd();
const SOURCE = sourceBinding(ROOT);
const VERSION = JSON.parse(fs.readFileSync('lerna.json', 'utf8')).version;

test('publication tail plan binds exact source and keeps side effects fresh', () => {
  const plan = buildAlphaPublicationTailPlan({
    sourceCommit: SOURCE.sourceCommit,
    sourceTree: SOURCE.sourceTree,
    generatedAt: '2026-07-26T02:00:00.000Z',
  });
  assert.equal(
    verifyAlphaPublicationTailPlan({
      plan,
      expectedSourceCommit: SOURCE.sourceCommit,
      expectedVersion: VERSION,
    }),
    plan,
  );
  assert.deepEqual(plan.reuse.requiredFreshEvidence, [
    'credentials',
    'github-release',
    'notarization',
    'publication',
    'public-readback',
    'signing',
  ]);
});

test('plan rejects source, tree, policy, version and root drift', () => {
  const plan = buildAlphaPublicationTailPlan({
    sourceCommit: SOURCE.sourceCommit,
    sourceTree: SOURCE.sourceTree,
  });
  for (const [field, value, pattern] of [
    ['sourceCommit', 'f'.repeat(40), /source commit mismatch/u],
    ['expectedVersion', '4.0.0-alpha.999', /version or tag mismatch/u],
  ]) {
    assert.throws(
      () =>
        verifyAlphaPublicationTailPlan({
          plan,
          expectedSourceCommit:
            field === 'sourceCommit' ? value : SOURCE.sourceCommit,
          expectedVersion: field === 'expectedVersion' ? value : VERSION,
        }),
      pattern,
    );
  }
  const poisoned = structuredClone(plan);
  poisoned.binding.policyRoot = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () =>
      verifyAlphaPublicationTailPlan({
        plan: poisoned,
        expectedSourceCommit: SOURCE.sourceCommit,
        expectedVersion: VERSION,
      }),
    /plan root mismatch/u,
  );
  assert.throws(
    () =>
      buildAlphaPublicationTailPlan({
        sourceCommit: SOURCE.sourceCommit,
        sourceTree: 'e'.repeat(40),
      }),
    /source tree does not match/u,
  );
});

test('payload discovery rejects missing and duplicate plans', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alpha-tail-plan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => findAlphaPublicationTailPlan(root), /found 0/u);
  const first = path.join(root, 'first', 'alpha-publication-tail-plan.json');
  fs.mkdirSync(path.dirname(first), { recursive: true });
  fs.writeFileSync(first, '{}\n');
  assert.equal(findAlphaPublicationTailPlan(root), first);
  const second = path.join(root, 'second', 'alpha-publication-tail-plan.json');
  fs.mkdirSync(path.dirname(second), { recursive: true });
  fs.writeFileSync(second, '{}\n');
  assert.throws(() => findAlphaPublicationTailPlan(root), /found 2/u);
});

test('Build DAG precomputes the tail while Buildchain owns signing', () => {
  const build = fs.readFileSync('.github/workflows/build.yml', 'utf8');
  const publication = fs.readFileSync(
    'scripts/alpha-publication-commit.mjs',
    'utf8',
  );
  assert.match(build, /^ {2}precompute-alpha-publication-tail:$/mu);
  assert.match(build, /precompute-alpha-publication-tail:[\s\S]*needs: build/u);
  assert.doesNotMatch(build, /^ {2}credential-island-macos:$/mu);
  assert.match(publication, /verifyAlphaPublicationTailPlan/u);
  assert.doesNotMatch(
    build.match(
      /precompute-alpha-publication-tail:[\s\S]*?(?=^ {2}[a-zA-Z0-9_-]+:|\s*$)/mu,
    )?.[0] || '',
    /secrets:|environment:/u,
  );
});
