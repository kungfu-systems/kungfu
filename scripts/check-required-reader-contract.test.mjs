// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONTRACT_PATH,
  evaluateRequiredReader,
  validateRequiredReaderContract,
} from './check-required-reader-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(
  fs.readFileSync(path.join(ROOT, CONTRACT_PATH), 'utf8'),
);

test('accepts the repository required-reader authority', () => {
  assert.deepEqual(
    validateRequiredReaderContract(contract, { root: ROOT }),
    [],
  );
});

test('preserves unknown bytes without semantic authority', () => {
  const result = evaluateRequiredReader(contract, {
    profile: 'preservation',
    materialState: 'well-formed-unknown-carrier',
  });
  assert.equal(result.outcome, 'preserve-only');
  assert.equal(result.exactBytesMustBePreserved, true);
  assert.equal(result.mayEnterCanonicalFold, false);
  assert.equal(result.mayAdmitAuthority, false);
});

test('separates structural from semantic verification', () => {
  const result = evaluateRequiredReader(contract, {
    profile: 'structural-verification',
    materialState: 'well-formed-unknown-schema',
  });
  assert.equal(result.outcome, 'read-degraded');
  assert.equal(result.structuralVerification, 'complete');
  assert.equal(result.semanticVerification, 'incomplete');
});

test('fails closed before fold, admission, and execution', () => {
  for (const profile of [
    'semantic-verification',
    'canonical-fold',
    'admission',
    'execution',
  ]) {
    const result = evaluateRequiredReader(contract, {
      profile,
      materialState: 'well-formed-unknown-schema',
    });
    assert.equal(result.outcome, 'migration-required');
    assert.equal(result.mayEnterCanonicalFold, false);
    assert.equal(result.mayAdmitAuthority, false);
    assert.equal(result.mayExecute, false);
  }
});

test('rejects malformed framing and missing required material deterministically', () => {
  assert.deepEqual(
    evaluateRequiredReader(contract, {
      profile: 'inspection',
      materialState: 'malformed-framing',
    }),
    {
      profile: 'inspection',
      materialState: 'malformed-framing',
      outcome: 'reject',
      code: 'E_READER_MALFORMED_FRAMING',
      exactBytesMustBePreserved: true,
      structuralVerification: 'not-claimed',
      semanticVerification: 'incomplete',
      mayEnterCanonicalFold: false,
      mayAdmitAuthority: false,
      mayExecute: false,
    },
  );
  assert.equal(
    evaluateRequiredReader(contract, {
      profile: 'execution',
      missingRequiredMaterial: true,
    }).code,
    'E_READER_REQUIRED_MATERIAL_MISSING',
  );
});

test('contract validation rejects silent unknown-to-authority drift', () => {
  const changed = structuredClone(contract);
  changed.readerProfiles.find(
    (profile) => profile.id === 'admission',
  ).unknownOutcome = 'read';
  assert.ok(
    validateRequiredReaderContract(changed, { root: ROOT }).some((issue) =>
      issue.includes('silently upgrades unknown material'),
    ),
  );
});
