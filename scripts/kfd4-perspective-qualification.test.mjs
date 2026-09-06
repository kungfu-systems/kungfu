// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  KFD4_QUALIFICATION_PATH,
  validateKfd4PerspectiveQualification,
} from '@kungfu-tech/core/testing/qualification/kfd4-perspective';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = JSON.parse(
  fs.readFileSync(path.join(ROOT, KFD4_QUALIFICATION_PATH), 'utf8'),
);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function rejects(mutate, pattern) {
  const report = clone(BASE);
  mutate(report);
  assert.throws(
    () => validateKfd4PerspectiveQualification(report, { root: ROOT }),
    pattern,
  );
}

test('retained KFD-4 qualification binds native facts to two perspectives without self-certification', () => {
  const result = validateKfd4PerspectiveQualification(BASE, { root: ROOT });
  assert.equal(result.ok, true);
  assert.equal(result.perspectiveCount, 2);
  assert.equal(result.negativeCaseCount, 6);
  assert.equal(result.qualifying, false);
  assert.equal(result.selfCertified, false);
  assert.equal(result.shippedSupport, false);
});

test('source binding drift fails closed', () => {
  rejects((report) => {
    report.source.bindings[0].sha256 = `sha256:${'0'.repeat(64)}`;
  }, /source binding root drifted/);
});

test('retained implementation provenance remains content-addressed', () => {
  rejects((report) => {
    report.source.implementationRevision = '0'.repeat(40);
  }, /implementation delivery binding root drifted/);
  rejects((report) => {
    report.source.deliveryBinding.mode = 'ancestry-only';
  }, /implementation delivery binding mode drifted/);
  rejects((report) => {
    report.source.deliveryBinding.root = `sha256:${'f'.repeat(64)}`;
  }, /implementation delivery binding root drifted/);
});

test('self-certification or shipped support widening fails closed', () => {
  rejects((report) => {
    report.verdict.selfCertified = true;
  }, /verdict must remain passed but non-qualifying/);
  rejects((report) => {
    report.verdict.shippedSupport = true;
  }, /verdict must remain passed but non-qualifying/);
});

test('projection root and causal-order drift fail closed', () => {
  rejects((report) => {
    report.perspectives[0].order = ['fact-a2', 'fact-b1', 'fact-a1'];
  }, /projection view root drifted/);
});

test('observer flattening fails closed', () => {
  rejects((report) => {
    report.perspectives[1].perspective.observer.id =
      report.perspectives[0].perspective.observer.id;
    report.perspectives[1].viewRoot = report.perspectives[0].viewRoot;
  }, /projection view root drifted|observer identities were flattened/);
});

test('negative-case and qualification-root drift fail closed', () => {
  rejects((report) => {
    report.negativeCases[0].observed = 'passed';
  }, /negative case did not fail closed/);
  rejects((report) => {
    report.qualificationRoot = `sha256:${'f'.repeat(64)}`;
  }, /qualification root drifted/);
});
