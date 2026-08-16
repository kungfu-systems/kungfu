// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { evaluateReleaseGate } from './gate.mjs';
import {
  adapterPath,
  qualificationRoot,
  readJson,
  semanticRoot,
  sha256,
  validateKfdPackage,
} from './lib.mjs';

const kfdRoot = path.resolve('node_modules/@kungfu-tech/kfd');

test('the product adapter is a thin command forwarder, not a Hub 20 rule table', () => {
  const text = fs.readFileSync(adapterPath, 'utf8');
  assert.match(text, /['"]agent['"],\s*['"]hub['"],\s*['"]handle['"]/);
  assert.doesNotMatch(text, /hub-00[1-9]|hub-01[0-9]|hub-020/);
  assert.doesNotMatch(text, /negotiate-exact-profile|authority-amplification/);
  assert.doesNotMatch(text, /switch\s*\(\s*.*scenario/);
  assert.match(text, /product-surface-unavailable/);
});

test('the exact KFD alpha package and all fixed roots match the retained lock', () => {
  const { lock, observed } = validateKfdPackage(kfdRoot);
  assert.equal(lock.version, '1.0.0-alpha.65');
  assert.equal(
    observed.suiteVectorRoot,
    'sha256:f1be3a10121fbd5389204b6e1ca70ea3920d9ba13ad20bb9f83fac078339c6b2',
  );
});

test('the reviewed responsibility map closes the exact 20-vector identity set', () => {
  const map = readJson(path.join(qualificationRoot, 'responsibility-map.json'));
  const vectors = readJson(
    path.join(kfdRoot, 'profiles/agent-hub/vectors/hub-20.json'),
  ).vectors;
  assert.equal(map.vectors.length, 20);
  assert.deepEqual(
    map.vectors.map(({ id }) => id).sort(),
    vectors.map(({ id }) => id).sort(),
  );
  for (const row of map.vectors) {
    assert.ok(row.authorityOwner);
    assert.ok(row.productEvidence);
    assert.deepEqual(
      row.expected,
      vectors.find(({ id }) => id === row.id).expect,
    );
  }
});

test('the first honest baseline is retained, complete, failing, and isolated', () => {
  const baseline = readJson(
    path.join(qualificationRoot, 'evidence/first-baseline.json'),
  );
  assert.equal(baseline.retained, true);
  assert.equal(baseline.replacementAllowed, false);
  assert.deepEqual(baseline.coverage, { total: 20, passed: 0, failed: 20 });
  assert.equal(baseline.execution.requestCount, 21);
  assert.equal(baseline.execution.responseCount, 21);
  assert.equal(baseline.isolation.homesDistinct, true);
  assert.equal(baseline.isolation.realHomeUnchanged, true);
  assert.equal(
    semanticRoot(baseline.isolation.realHomeBefore),
    semanticRoot(baseline.isolation.realHomeAfter),
  );
  assert.equal(baseline.valid, false);
  assert.equal(
    baseline.adapter.artifactDigest,
    sha256(
      fs.readFileSync(
        path.join(
          qualificationRoot,
          'evidence/first-baseline-adapter.snapshot',
        ),
      ),
    ),
  );
});

function passingGateFixture() {
  const lock = { package: '@kungfu-tech/kfd', version: '1.0.0-alpha.65' };
  const observed = { suiteVectorRoot: `sha256:${'a'.repeat(64)}` };
  const adapterDigest = `sha256:${'b'.repeat(64)}`;
  const product = {
    provenance: 'installed-product',
    sourcePristine: true,
    sourceCommit: 'candidate-commit',
    releaseManifestSourceCommit: 'candidate-commit',
  };
  const report = {
    adapter: { artifactDigest: adapterDigest },
    execution: {
      transcriptRoot: `sha256:${'c'.repeat(64)}`,
      resultRoot: `sha256:${'d'.repeat(64)}`,
    },
    coverage: { total: 20, passed: 20, failed: 0 },
    valid: true,
  };
  const home = {
    pathClass: 'user-kungfu-home',
    metadataRoot: `sha256:${'e'.repeat(64)}`,
    contentRead: false,
  };
  const qualification = {
    schema: 'kungfu.kfd-agent-hub-20-qualification/v1',
    claim: 'installed-kungfu-local-peer-kfd-agent-hub-20',
    kfd: {
      lock: structuredClone(lock),
      observed: structuredClone(observed),
    },
    adapter: {
      artifactDigest: adapterDigest,
      sourceClassification: 'product-command-forwarder',
      semanticAuthority: 'installed Kungfu agent hub handle command',
    },
    product,
    isolation: {
      homesDistinct: true,
      sourceStorePresent: true,
      targetStorePresent: true,
      realHomeUnchanged: true,
      realHomeBefore: home,
      realHomeAfter: structuredClone(home),
    },
    report: {
      digest: semanticRoot(report),
      transcriptRoot: report.execution.transcriptRoot,
      resultRoot: report.execution.resultRoot,
    },
    qualifyingBoundary: {
      excludes: ['KFD certification', 'stable or public release'],
    },
    releaseGateInput: true,
    valid: true,
  };
  return {
    qualification,
    report,
    lock,
    observed,
    currentProduct: structuredClone(product),
    currentAdapterDigest: adapterDigest,
    offlineVerifierStatus: 0,
    offline: { valid: true },
  };
}

test('the release gate rejects every stale, source, isolation, closure, and scope class', () => {
  assert.equal(evaluateReleaseGate(passingGateFixture()).valid, true);
  const cases = [
    [
      'kfd-lock',
      (fixture) => {
        fixture.qualification.kfd.lock.version = 'stale';
      },
    ],
    [
      'adapter-artifact',
      (fixture) => {
        fixture.qualification.adapter.artifactDigest = `sha256:${'0'.repeat(64)}`;
      },
    ],
    [
      'adapter-provenance',
      (fixture) => {
        fixture.qualification.adapter.sourceClassification =
          'source-shifu-semantic-adapter';
      },
    ],
    [
      'installed-product',
      (fixture) => {
        fixture.currentProduct.sourceCommit = 'other-commit';
      },
    ],
    [
      'dual-hub-isolation',
      (fixture) => {
        fixture.qualification.isolation.homesDistinct = false;
      },
    ],
    [
      'report-closure',
      (fixture) => {
        fixture.report.coverage.passed = 19;
        fixture.report.coverage.failed = 1;
      },
    ],
    [
      'offline-verifier',
      (fixture) => {
        fixture.offline.valid = false;
      },
    ],
    [
      'claim-boundary',
      (fixture) => {
        fixture.qualification.qualifyingBoundary.excludes = [];
      },
    ],
  ];
  for (const [expectedCheck, mutate] of cases) {
    const fixture = passingGateFixture();
    mutate(fixture);
    const result = evaluateReleaseGate(fixture);
    assert.equal(result.valid, false, expectedCheck);
    assert.equal(
      result.checks.find(({ id }) => id === expectedCheck).passed,
      false,
      expectedCheck,
    );
  }
});
