// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const CONTRACT_PATH =
  'framework/release/kungfu-durable-provenance-authority.contract.json';
const REPORT_PATH =
  'docs/qualification/evidence/durable-provenance-authority/v1/report.json';
const BUNDLE_PATH =
  'docs/qualification/evidence/durable-provenance-authority/v1/authority-bundle.json';
const read = (relative) => fs.readFileSync(path.join(ROOT, relative));
const readJson = (relative) => JSON.parse(read(relative));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

function root(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')}`;
}

function fileRoot(relative) {
  return `sha256:${crypto.createHash('sha256').update(read(relative)).digest('hex')}`;
}

function bundleRoot(value) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      `kungfu.fact-kernel.integrity-root/v1\0portable-bundle/v1\0${JSON.stringify(
        canonical(value),
      )}`,
    )
    .digest('hex')}`;
}

function semanticRelease(release, acknowledgesCutRoot) {
  return {
    schema: 'kungfu.release-provenance-authority-fact/v1',
    releaseId: release.releaseId,
    sourceContent: release.sourceContent,
    sealedCandidateRoot: release.sealedCandidateRoot,
    candidateInventoryRoot: release.candidateInventoryRoot,
    candidateProvenanceRoot: release.candidateProvenanceRoot,
    qualificationRoots: release.qualificationRoots,
    contractRoots: release.contractRoots,
    acknowledgesCutRoot,
  };
}

test('retained Fact/Cut authority is production eligible and exactly rooted', () => {
  const contract = readJson(CONTRACT_PATH);
  const report = readJson(REPORT_PATH);
  const bundle = readJson(BUNDLE_PATH);
  const { qualificationRoot, ...reportBody } = report;
  const { bundle_root: retainedBundleRoot, ...bundleBody } = bundle;

  assert.equal(contract.status, 'production');
  assert.deepEqual(
    {
      kind: contract.authority.kind,
      defaultEnabled: contract.authority.defaultEnabled,
      productionEligible: contract.authority.productionEligible,
      scope: contract.authority.productionEligibilityScope,
    },
    {
      kind: 'local-immutable-fact-cut-chain',
      defaultEnabled: true,
      productionEligible: true,
      scope: 'release-provenance-fact-cut-authority',
    },
  );
  assert.equal(report.status, 'production-qualified');
  assert.equal(report.defaultEnabled, true);
  assert.equal(report.productionEligible, true);
  assert.equal(report.contractRoot, root(contract));
  assert.equal(qualificationRoot, root(reportBody));
  assert.equal(retainedBundleRoot, bundleRoot(bundleBody));
  assert.equal(report.portableBundle.bundleRoot, retainedBundleRoot);
  assert.deepEqual(bundle.loss, []);
  assert.equal(report.qualification.semanticReplayEqual, true);
  assert.equal(report.qualification.historicalCutCount, 2);
  assert.equal(report.qualification.gitOrGitHubReads, 0);
  assert.equal(
    report.qualification.rollback.pinnedFinalCutStillQueryable,
    true,
  );
  assert.deepEqual(
    report.qualification.failureCampaigns.map(({ id, status }) => [id, status]),
    [
      ['tampered-root', 'passed'],
      ['missing-payload', 'passed'],
      ['incomplete-backfill', 'passed'],
    ],
  );
  for (const source of report.source.files)
    assert.equal(fileRoot(source.path), source.root, source.path);
  assert.equal(report.source.sourceSetRoot, root(report.source.files));
});

test('Alpha.1 and Alpha.2 semantics survive topology removal and flattening', () => {
  const contract = readJson(CONTRACT_PATH);
  const report = readJson(REPORT_PATH);
  const [alpha1, alpha2] = contract.history.releases;
  const [alpha1Fact, alpha2Fact] = report.authority.releases;

  assert.equal(alpha1.releaseId, 'v4.0.0-alpha.1');
  assert.equal(alpha2.releaseId, 'v4.0.0-alpha.2');
  assert.equal(alpha2.sourceContent.contentRoot, alpha2.candidateInventoryRoot);
  assert.equal(
    report.qualification.sameTreeDifferentHistory.sourceContentRootsEqual,
    true,
  );
  assert.equal(
    report.qualification.sameTreeDifferentHistory.releaseCutRootsDistinct,
    true,
  );
  assert.equal(
    report.qualification.sameTreeDifferentHistory
      .flattenedProjectionPreservesSemanticRoot,
    true,
  );
  assert.notEqual(alpha1Fact.cutRoot, alpha2Fact.cutRoot);
  assert.equal(alpha2Fact.relationRoot?.startsWith('sha256:'), true);

  const flattened = structuredClone(alpha2);
  flattened.projection.observedParents = [];
  flattened.projection.candidateCommit = '0'.repeat(40);
  assert.deepEqual(
    semanticRelease(alpha2, alpha1Fact.cutRoot),
    semanticRelease(flattened, alpha1Fact.cutRoot),
  );
});

test('normal release routing no longer evaluates historical parent topology', () => {
  const contract = readJson(CONTRACT_PATH);
  const patrol = read(
    '.github/workflows/dev-alpha-candidate-patrol.yml',
  ).toString();
  const build = read('.github/workflows/build.yml').toString();
  const promotion = read(
    '.github/workflows/release-new-version.yml',
  ).toString();

  for (const workflow of [patrol, build, promotion]) {
    assert.match(workflow, /check:durable-provenance-authority/u);
    assert.doesNotMatch(workflow, /git show -s --format=%P/u);
    assert.doesNotMatch(workflow, /candidate-provenance|promotion-provenance/u);
  }
  assert.doesNotMatch(patrol, /git fetch --no-tags --depth=2/u);
  assert.doesNotMatch(build, /RELEASE_CUT_SOURCE_REF/u);
  assert.doesNotMatch(build, /alphaBaseSha/u);
  assert.deepEqual(contract.releaseRehearsal, {
    mode: 'normal-protected-non-public',
    gate: 'governance.promotion-rehearsal',
    publication: false,
    topologyRequirement: 'none',
    specialPromotionRoute: false,
    handMaintainedAllowlist: false,
    prooflessFallback: false,
  });
  assert.deepEqual(Object.values(contract.retirement.activeModes), [
    'retired',
    'retired',
    'retired',
    'retired',
    'retired',
  ]);
});
