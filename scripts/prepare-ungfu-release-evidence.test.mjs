// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createUngfuEvidencePreparation,
  readBackUngfuReleaseEvidence,
  validateUngfuReleaseEvidence,
} from './prepare-ungfu-release-evidence.mjs';
import { loadTrademarkPublicUse } from './trademark-public-use-contract.mjs';

const SOURCE_SHA = '0123456789abcdef0123456789abcdef01234567';
const VERSION = '4.0.0-alpha.1';
const TAG = `v${VERSION}`;
const COORDINATE = `github-release:${TAG}`;
const ARTIFACT_SHA = 'a'.repeat(64);
const TODAY = new Date().toISOString().slice(0, 10);

function releasedFixture() {
  const plans =
    loadTrademarkPublicUse().contract.firstPublicReleaseGate
      .class9FilingReadiness.coreIdentifications;
  const acquisitionUrl = `https://github.com/kungfu-systems/kungfu/releases/download/${TAG}/kungfu-cli.tar.gz`;
  const pageUrl = 'https://kungfu.tech/install/';
  const productUrl = `https://github.com/kungfu-systems/kungfu/releases/download/${TAG}/kungfu-cli.qualification.json`;
  const acquisition = {
    id: 'install-page',
    kind: 'public-release-download',
    exactMark: 'Kungfu UNGFU™',
    softwareDescription:
      'Downloadable software for durable AI-agent work, inspection, and development workflows.',
    publicUrl: pageUrl,
    acquisitionUrl,
    accessedAt: TODAY,
    sourceCommit: SOURCE_SHA,
    deploymentOrReleaseCoordinate: COORDINATE,
    renderedEvidence: `https://kungfu.tech/evidence/${TAG}/install-page.html`,
  };
  const product = {
    id: 'cli-version',
    kind: 'kungfu --version',
    exactMark: 'Kungfu UNGFU™',
    publicUrl: productUrl,
    accessedAt: TODAY,
    sourceCommit: SOURCE_SHA,
    deploymentOrReleaseCoordinate: COORDINATE,
    renderedEvidence: productUrl,
  };
  const specimenRecord = {
    kind: 'release',
    acquisitionSurfaceId: acquisition.id,
    productSurfaceId: product.id,
    publicUrl: pageUrl,
    accessedAt: TODAY,
    sourceRepository: 'https://github.com/kungfu-systems/kungfu',
    sourceCommit: SOURCE_SHA,
    deploymentOrReleaseCoordinate: COORDINATE,
    renderedEvidence: acquisition.renderedEvidence,
  };
  const class9Records = plans.map((plan) => ({
    id: `class9-${plan.planId}`,
    planId: plan.planId,
    termId: plan.termId,
    identification: plan.identification,
    status: 'released',
    capabilityEvidenceKind:
      plan.planId === 'application-programming-interface'
        ? 'released-sdk-capability'
        : 'released-cli-capability',
    commandOrSurface: `kungfu qualification ${plan.planId}`,
    qualificationCheck: 'checks.releaseCapability.passed',
    publicUrl: productUrl,
    accessedAt: TODAY,
    sourceRepository: 'https://github.com/kungfu-systems/kungfu',
    sourceCommit: SOURCE_SHA,
    acquisitionSurfaceId: acquisition.id,
    productSurfaceId: product.id,
    deploymentOrReleaseCoordinate: COORDINATE,
    renderedEvidence: productUrl,
  }));
  return {
    schemaVersion: 1,
    contract: 'kungfu-ungfu-release-evidence-index',
    id: 'ungfu-public-use',
    kind: 'public-acquisition-and-capability-evidence',
    state: 'released-observation',
    release: {
      sourceSha: SOURCE_SHA,
      tag: TAG,
      channel: 'alpha',
      version: VERSION,
      deploymentCoordinate: COORDINATE,
      artifactRoots: [
        { name: 'kungfu-cli.tar.gz', sha256: `sha256:${ARTIFACT_SHA}` },
      ],
    },
    layers: {
      specimen: {
        role: 'filing-oriented-acquisition-product-pair',
        acquisition,
        product,
        records: [specimenRecord],
      },
      class9CapabilityTruth: {
        role: 'released-capability-truth',
        records: class9Records,
      },
      brandArchive: {
        role: 'supporting-history-only',
        primaryEvidence: false,
        records: [
          {
            kind: 'public-brand-history',
            url: 'https://kungfu.tech/about/',
          },
        ],
      },
    },
    legalBoundary: {
      firstUseDateClaim: null,
      legalConclusion: 'not-made',
      registrationStatusClaim: 'none',
      counselReviewRequired: true,
    },
  };
}

test('preparation is valid but cannot become a released-use claim', () => {
  const prepared = createUngfuEvidencePreparation();
  assert.deepEqual(validateUngfuReleaseEvidence(prepared), []);
  assert.ok(
    validateUngfuReleaseEvidence(prepared, { requireReleased: true }).some(
      (issue) => issue.includes('cannot satisfy'),
    ),
  );
  assert.equal(prepared.legalBoundary.firstUseDateClaim, null);
  assert.equal(prepared.legalBoundary.legalConclusion, 'not-made');
});

test('released evidence binds all three layers to one exact release', () => {
  assert.deepEqual(
    validateUngfuReleaseEvidence(releasedFixture(), {
      requireReleased: true,
    }),
    [],
  );
});

test('released evidence fails closed on stale, preparatory, or inferred facts', () => {
  for (const [label, mutate] of [
    [
      'source',
      (candidate) => {
        candidate.layers.specimen.product.sourceCommit = 'b'.repeat(40);
      },
    ],
    [
      'preview',
      (candidate) => {
        candidate.layers.specimen.acquisition.publicUrl =
          'https://preview.kungfu.tech/install/';
      },
    ],
    [
      'software description',
      (candidate) => {
        candidate.layers.specimen.acquisition.softwareDescription =
          'Download software.';
      },
    ],
    [
      'future date',
      (candidate) => {
        candidate.layers.specimen.acquisition.accessedAt = '2999-01-01';
      },
    ],
    [
      'artifact root',
      (candidate) => {
        candidate.release.artifactRoots[0].sha256 = 'sha256:short';
      },
    ],
    [
      'registered symbol',
      (candidate) => {
        candidate.layers.brandArchive.records[0].label = 'Kungfu®';
      },
    ],
  ]) {
    const candidate = releasedFixture();
    mutate(candidate);
    assert.notDeepEqual(
      validateUngfuReleaseEvidence(candidate, { requireReleased: true }),
      [],
      label,
    );
  }
});

test('public readback proves adjacent acquisition copy and installed product identity', async () => {
  const candidate = releasedFixture();
  const acquisition = candidate.layers.specimen.acquisition;
  const product = candidate.layers.specimen.product;
  const html = `<section data-ungfu-release-acquisition><strong>Kungfu UNGFU™</strong><p>${acquisition.softwareDescription}</p><span>${VERSION}</span><span>alpha</span><a href="${acquisition.acquisitionUrl}">Install</a></section>`;
  const qualification = {
    schema: 'kungfu.cli-installed-product-qualification/v1',
    qualified: true,
    version: VERSION,
    identity: { archiveSha256: ARTIFACT_SHA },
    productIdentity: {
      exactMark: 'Kungfu UNGFU™',
      principle: 'Never Guess. Facts Unfold.',
    },
    checks: { releaseCapability: { passed: true } },
  };
  const fetchImpl = async (url) => {
    if (url === acquisition.publicUrl) {
      return new Response(html, { status: 200 });
    }
    if (url === product.publicUrl) {
      return Response.json(qualification);
    }
    return new Response('public evidence', { status: 200 });
  };
  const result = await readBackUngfuReleaseEvidence(candidate, { fetchImpl });
  assert.equal(result.version, VERSION);
  assert.equal(result.sourceSha, SOURCE_SHA);

  await assert.rejects(
    readBackUngfuReleaseEvidence(candidate, {
      fetchImpl: async (url) =>
        url === acquisition.acquisitionUrl
          ? new Response('missing', { status: 404 })
          : fetchImpl(url),
    }),
    /acquisition action returned HTTP 404/,
  );
  await assert.rejects(
    readBackUngfuReleaseEvidence(candidate, {
      fetchImpl: async (url) =>
        url === acquisition.publicUrl
          ? new Response(
              '<section data-ungfu-release-acquisition>Coming Soon</section>',
            )
          : fetchImpl(url),
    }),
    /does not keep the exact mark/,
  );
});
