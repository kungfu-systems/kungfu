// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { devQueueQualificationImpact } from './run-core-affected-native.mjs';

test('dev queue impact keeps unrelated source changes out of optional heavy gates', () => {
  assert.deepEqual(devQueueQualificationImpact(['framework/gui/src/app.ts']), {
    shifuWorkspace: { required: false, reasons: [] },
    kfdVerifier: { required: false, reasons: [] },
  });
});

test('dev queue impact selects Shifu and KFD from their declared source surfaces', () => {
  const impact = devQueueQualificationImpact([
    'docs/development/buildchain.md',
    'crates/xinfa/src/lib.rs',
  ]);
  assert.equal(impact.shifuWorkspace.required, true);
  assert.deepEqual(
    impact.shifuWorkspace.reasons.map(({ path }) => path),
    ['crates/xinfa/src/lib.rs', 'docs/development/buildchain.md'],
  );
  assert.equal(impact.kfdVerifier.required, true);
  assert.deepEqual(
    impact.kfdVerifier.reasons.map(({ path }) => path),
    ['crates/xinfa/src/lib.rs'],
  );
});

test('the staged workflow remains self-qualifying under both moved gates', () => {
  const impact = devQueueQualificationImpact([
    '.github/workflows/affected-native-pr.yml',
  ]);
  assert.equal(impact.shifuWorkspace.required, true);
  assert.equal(impact.kfdVerifier.required, true);
});
