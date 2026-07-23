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

test('preview or staging cannot satisfy the first real release gate', () => {
  const candidate = fixture();
  candidate.contract.currentState.publicReleaseArtifactsAvailable = true;
  candidate.contract.currentState.releasedSoftwareUseClaim = true;
  candidate.contract.currentState.acquisitionSurfaces = [
    {
      kind: 'public-release-download',
      evidenceKind: 'preview',
      exactMark: EXACT_MARK,
      publicUrl: 'https://preview.example/download',
    },
  ];
  candidate.contract.currentState.productSurfaces = [
    {
      kind: 'kungfu --version',
      exactMark: EXACT_MARK,
    },
  ];
  candidate.contract.currentState.evidenceRecords = [
    {
      kind: 'staging',
      publicUrl: 'https://staging.example/download',
      accessedAt: '2026-07-23',
      sourceRepository: 'https://github.com/kungfu-systems/kungfu',
      sourceCommit: '0123456789abcdef0123456789abcdef01234567',
      deploymentOrReleaseCoordinate: 'preview-1',
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
});
