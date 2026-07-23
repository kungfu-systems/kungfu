// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXACT_MARK,
  loadTrademarkPublicUse,
  validateTrademarkPublicUse,
} from './trademark-public-use-contract.mjs';

function fixture() {
  return structuredClone(loadTrademarkPublicUse());
}

function addCoreClass9Evidence(candidate, coordinate) {
  const plans =
    candidate.contract.firstPublicReleaseGate.class9FilingReadiness
      .coreIdentifications;
  candidate.contract.currentState.class9GoodsEvidence = plans.map(
    (plan, index) => ({
      id: `class9-${plan.planId}`,
      planId: plan.planId,
      termId: plan.termId,
      identification: plan.identification,
      status: 'released',
      capabilityEvidenceKind:
        plan.planId === 'application-programming-interface'
          ? 'released-sdk-capability'
          : 'released-cli-capability',
      commandOrSurface: `qualification/class9/${plan.planId}`,
      publicUrl: `https://kungfu.tech/evidence/v4.0.0/class9-${index}.html`,
      accessedAt: new Date().toISOString().slice(0, 10),
      sourceRepository: 'https://github.com/kungfu-systems/kungfu',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      acquisitionSurfaceId: 'download',
      productSurfaceId: 'cli-version',
      deploymentOrReleaseCoordinate: coordinate,
      renderedEvidence: `https://kungfu.tech/evidence/v4.0.0/class9-${index}.png`,
    }),
  );
}

test('the current pre-release state is truthful and complete', () => {
  const { contract, surfaces } = fixture();
  assert.deepEqual(validateTrademarkPublicUse(contract, surfaces), []);
  assert.equal(contract.currentState.releasedSoftwareUseClaim, false);
  assert.equal(contract.currentState.evidenceRecords.length, 0);
});

test('registered symbols and unsupported registration claims are rejected', () => {
  const registeredSymbol = fixture();
  registeredSymbol.surfaces['README.md'] += '\nKungfu UNGFU®\n';
  assert.ok(
    validateTrademarkPublicUse(
      registeredSymbol.contract,
      registeredSymbol.surfaces,
    ).some((item) => item.includes('registered symbol')),
  );

  const registrationClaim = fixture();
  registrationClaim.surfaces['TRADEMARK.md'] +=
    '\nKungfu UNGFU is a registered trademark.\n';
  assert.ok(
    validateTrademarkPublicUse(
      registrationClaim.contract,
      registrationClaim.surfaces,
    ).some((item) => item.includes('unsupported registration')),
  );
});

test('renaming the product or removing an exact-mark surface is rejected', () => {
  const renamed = fixture();
  renamed.contract.brand.primaryProductName = 'UNGFU';
  assert.ok(
    validateTrademarkPublicUse(renamed.contract, renamed.surfaces).includes(
      'primary product name must remain Kungfu',
    ),
  );

  const missing = fixture();
  missing.surfaces['README.md'] = missing.surfaces['README.md'].replace(
    EXACT_MARK,
    'Kungfu',
  );
  assert.ok(
    validateTrademarkPublicUse(missing.contract, missing.surfaces).some(
      (item) => item.includes('README first screen'),
    ),
  );
});

test('renaming protected technical identifiers or packages is rejected', () => {
  for (const [field, replacement] of [
    ['repository', 'ungfu-systems/ungfu'],
    ['cli', 'ungfu'],
    ['npmScope', '@ungfu/'],
    ['productDomain', 'ungfu.example'],
    ['developerDomain', 'developers.ungfu.example'],
    ['protocol', 'UNGFU'],
    ['releaseSystem', 'UNGFU Chain'],
    ['localRuntime', 'libungfu'],
  ]) {
    const renamed = fixture();
    renamed.contract.brand.protectedTechnicalIdentifiers[field] = replacement;
    assert.ok(
      validateTrademarkPublicUse(renamed.contract, renamed.surfaces).some(
        (item) => item.includes('identifiers must not be renamed'),
      ),
      field,
    );
  }

  const npmPackage = fixture();
  npmPackage.surfaces['framework/core/package.json'] = npmPackage.surfaces[
    'framework/core/package.json'
  ].replace('@kungfu-tech/core', '@ungfu/core');
  assert.ok(
    validateTrademarkPublicUse(npmPackage.contract, npmPackage.surfaces).some(
      (item) => item.includes('npm package'),
    ),
  );

  const cli = fixture();
  cli.surfaces['framework/core/package.json'] = cli.surfaces[
    'framework/core/package.json'
  ].replace('"kungfu": "lib/kungfu-cli.js"', '"ungfu": "lib/kungfu-cli.js"');
  assert.ok(
    validateTrademarkPublicUse(cli.contract, cli.surfaces).some((item) =>
      item.includes('kungfu CLI binding'),
    ),
  );

  const pythonPackage = fixture();
  pythonPackage.surfaces['framework/core/pyproject.toml'] =
    pythonPackage.surfaces['framework/core/pyproject.toml'].replace(
      'name = "kungfu"',
      'name = "ungfu"',
    );
  assert.ok(
    validateTrademarkPublicUse(
      pythonPackage.contract,
      pythonPackage.surfaces,
    ).some((item) => item.includes('Python package')),
  );

  const publicIdentifier = fixture();
  publicIdentifier.surfaces['README.md'] = publicIdentifier.surfaces[
    'README.md'
  ].replaceAll('libkungfu.dev', 'libungfu.example');
  assert.ok(
    validateTrademarkPublicUse(
      publicIdentifier.contract,
      publicIdentifier.surfaces,
    ).some((item) => item.includes('libkungfu identity')),
  );

  const reordered = fixture();
  reordered.contract.brand.protectedTechnicalIdentifiers = Object.fromEntries(
    Object.entries(
      reordered.contract.brand.protectedTechnicalIdentifiers,
    ).reverse(),
  );
  assert.deepEqual(
    validateTrademarkPublicUse(reordered.contract, reordered.surfaces),
    [],
  );
});

test('preview or staging cannot satisfy the first real release gate', () => {
  const candidate = fixture();
  candidate.contract.currentState.publicReleaseArtifactsAvailable = true;
  candidate.contract.currentState.releasedSoftwareUseClaim = true;
  candidate.contract.currentState.acquisitionSurfaces = [
    {
      id: 'download',
      kind: 'public-release-download',
      evidenceKind: 'preview',
      exactMark: EXACT_MARK,
      publicUrl: 'https://preview.example/download',
      deploymentOrReleaseCoordinate: 'github-release:v4.0.0',
    },
  ];
  candidate.contract.currentState.productSurfaces = [
    {
      id: 'cli-version',
      kind: 'kungfu --version',
      exactMark: EXACT_MARK,
      deploymentOrReleaseCoordinate: 'github-release:v4.0.0',
    },
  ];
  candidate.contract.currentState.evidenceRecords = [
    {
      kind: 'staging',
      acquisitionSurfaceId: 'download',
      productSurfaceId: 'cli-version',
      publicUrl: 'https://staging.example/download',
      accessedAt: '2026-07-23',
      sourceRepository: 'https://github.com/kungfu-systems/kungfu',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      deploymentOrReleaseCoordinate: 'github-release:v4.0.0',
      renderedEvidence: 'https://staging.example/evidence.png',
    },
  ];
  const issues = validateTrademarkPublicUse(
    candidate.contract,
    candidate.surfaces,
  );
  assert.ok(issues.some((item) => item.includes('real public acquisition')));
  assert.ok(
    issues.some((item) => item.includes('complete public-safe evidence')),
  );

  candidate.contract.currentState.acquisitionSurfaces[0].evidenceKind =
    'release';
  candidate.contract.currentState.evidenceRecords[0].kind = 'release';
  assert.ok(
    validateTrademarkPublicUse(candidate.contract, candidate.surfaces).some(
      (item) => item.includes('real public acquisition surface'),
    ),
  );
});

test('released use requires source-bound public evidence for one exact release', () => {
  const candidate = fixture();
  candidate.contract.currentState.publicReleaseArtifactsAvailable = true;
  candidate.contract.currentState.releasedSoftwareUseClaim = true;
  const coordinate = 'github-release:v4.0.0';
  candidate.contract.currentState.acquisitionSurfaces = [
    {
      id: 'download',
      kind: 'public-release-download',
      evidenceKind: 'release',
      exactMark: EXACT_MARK,
      publicUrl:
        'https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0/kungfu-macos.zip',
      deploymentOrReleaseCoordinate: coordinate,
    },
  ];
  candidate.contract.currentState.productSurfaces = [
    {
      id: 'cli-version',
      kind: 'kungfu --version',
      exactMark: EXACT_MARK,
      deploymentOrReleaseCoordinate: coordinate,
    },
  ];
  candidate.contract.currentState.evidenceRecords = [
    {
      kind: 'release',
      acquisitionSurfaceId: 'download',
      productSurfaceId: 'cli-version',
      publicUrl:
        'https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0/kungfu-macos.zip',
      accessedAt: new Date().toISOString().slice(0, 10),
      sourceRepository: 'https://github.com/kungfu-systems/kungfu',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      deploymentOrReleaseCoordinate: coordinate,
      renderedEvidence:
        'https://kungfu.tech/evidence/v4.0.0/kungfu-version.png',
    },
  ];
  addCoreClass9Evidence(candidate, coordinate);
  assert.deepEqual(
    validateTrademarkPublicUse(candidate.contract, candidate.surfaces),
    [],
  );

  for (const mutate of [
    (item) => {
      item.sourceCommit = 'not-a-full-commit';
    },
    (item) => {
      item.sourceRepository = 'https://example.com/not-kungfu';
    },
    (item) => {
      item.accessedAt = '2999-01-01';
    },
    (item) => {
      item.renderedEvidence = 'file:///private/specimen.png';
    },
    (item) => {
      item.deploymentOrReleaseCoordinate = 'github-release:v4.0.1';
    },
    (item) => {
      item.productSurfaceId = 'missing-surface';
    },
  ]) {
    const invalid = structuredClone(candidate);
    mutate(invalid.contract.currentState.evidenceRecords[0]);
    assert.ok(
      validateTrademarkPublicUse(invalid.contract, invalid.surfaces).some(
        (item) =>
          item.includes('bound to the acquisition and product surfaces'),
      ),
    );
  }
});

test('released use requires evidence for every core Class 9 identification', () => {
  const candidate = fixture();
  candidate.contract.currentState.publicReleaseArtifactsAvailable = true;
  candidate.contract.currentState.releasedSoftwareUseClaim = true;
  const coordinate = 'github-release:v4.0.0-alpha.1';
  candidate.contract.currentState.acquisitionSurfaces = [
    {
      id: 'download',
      kind: 'public-release-download',
      evidenceKind: 'release',
      exactMark: EXACT_MARK,
      publicUrl:
        'https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0-alpha.1/kungfu-macos.zip',
      deploymentOrReleaseCoordinate: coordinate,
    },
  ];
  candidate.contract.currentState.productSurfaces = [
    {
      id: 'cli-version',
      kind: 'kungfu --version',
      exactMark: EXACT_MARK,
      deploymentOrReleaseCoordinate: coordinate,
    },
  ];
  candidate.contract.currentState.evidenceRecords = [
    {
      kind: 'release',
      acquisitionSurfaceId: 'download',
      productSurfaceId: 'cli-version',
      publicUrl:
        'https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0-alpha.1/kungfu-macos.zip',
      accessedAt: new Date().toISOString().slice(0, 10),
      sourceRepository: 'https://github.com/kungfu-systems/kungfu',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      deploymentOrReleaseCoordinate: coordinate,
      renderedEvidence:
        'https://kungfu.tech/evidence/v4.0.0-alpha.1/kungfu-version.png',
    },
  ];
  addCoreClass9Evidence(candidate, coordinate);
  assert.deepEqual(
    validateTrademarkPublicUse(candidate.contract, candidate.surfaces),
    [],
  );

  const missing = structuredClone(candidate);
  missing.contract.currentState.class9GoodsEvidence.pop();
  assert.ok(
    validateTrademarkPublicUse(missing.contract, missing.surfaces).some(
      (item) => item.includes('every core Class 9 identification'),
    ),
  );

  const roadmap = structuredClone(candidate);
  roadmap.contract.currentState.class9GoodsEvidence[0].capabilityEvidenceKind =
    'roadmap';
  const roadmapIssues = validateTrademarkPublicUse(
    roadmap.contract,
    roadmap.surfaces,
  );
  assert.ok(
    roadmapIssues.some((item) =>
      item.includes('every core Class 9 identification'),
    ),
  );
  assert.ok(
    roadmapIssues.some((item) =>
      item.includes('complete released-product evidence'),
    ),
  );

  const drifted = structuredClone(candidate);
  drifted.contract.currentState.class9GoodsEvidence[1].identification +=
    ' and future services';
  assert.ok(
    validateTrademarkPublicUse(drifted.contract, drifted.surfaces).some(
      (item) => item.includes('complete released-product evidence'),
    ),
  );
});

test('conditional Class 9 items require released evidence when selected', () => {
  const candidate = fixture();
  candidate.contract.currentState.publicReleaseArtifactsAvailable = true;
  candidate.contract.currentState.releasedSoftwareUseClaim = true;
  const coordinate = 'github-release:v4.0.0-alpha.1';
  candidate.contract.currentState.acquisitionSurfaces = [
    {
      id: 'download',
      kind: 'public-release-download',
      evidenceKind: 'release',
      exactMark: EXACT_MARK,
      publicUrl:
        'https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0-alpha.1/kungfu-macos.zip',
      deploymentOrReleaseCoordinate: coordinate,
    },
  ];
  candidate.contract.currentState.productSurfaces = [
    {
      id: 'cli-version',
      kind: 'kungfu --version',
      exactMark: EXACT_MARK,
      deploymentOrReleaseCoordinate: coordinate,
    },
  ];
  candidate.contract.currentState.evidenceRecords = [
    {
      kind: 'release',
      acquisitionSurfaceId: 'download',
      productSurfaceId: 'cli-version',
      publicUrl:
        'https://github.com/kungfu-systems/kungfu/releases/download/v4.0.0-alpha.1/kungfu-macos.zip',
      accessedAt: new Date().toISOString().slice(0, 10),
      sourceRepository: 'https://github.com/kungfu-systems/kungfu',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      deploymentOrReleaseCoordinate: coordinate,
      renderedEvidence:
        'https://kungfu.tech/evidence/v4.0.0-alpha.1/kungfu-version.png',
    },
  ];
  addCoreClass9Evidence(candidate, coordinate);
  const conditional =
    candidate.contract.firstPublicReleaseGate.class9FilingReadiness
      .conditionalIdentifications[1];
  candidate.contract.currentState.class9GoodsEvidence.push({
    id: `class9-${conditional.planId}`,
    planId: conditional.planId,
    termId: conditional.termId,
    identification: conditional.identification,
    status: 'planned',
    capabilityEvidenceKind: 'source-only',
    commandOrSurface: 'framework/kfx',
    publicUrl:
      'https://github.com/kungfu-systems/kungfu/tree/dev/v4/v4.0/framework/kfx',
    accessedAt: new Date().toISOString().slice(0, 10),
    sourceRepository: 'https://github.com/kungfu-systems/kungfu',
    sourceCommit: '0123456789abcdef0123456789abcdef01234567',
    acquisitionSurfaceId: 'download',
    productSurfaceId: 'cli-version',
    deploymentOrReleaseCoordinate: coordinate,
    renderedEvidence:
      'https://kungfu.tech/evidence/v4.0.0-alpha.1/kfx-source.png',
  });
  assert.ok(
    validateTrademarkPublicUse(candidate.contract, candidate.surfaces).some(
      (item) => item.includes('complete released-product evidence'),
    ),
  );
});
