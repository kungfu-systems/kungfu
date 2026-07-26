// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { runPortableFormatMigrationCampaign } from './portable-format-migration-campaign.mjs';

test('qualifies the complete disposable migration and repair campaign', () => {
  const first = runPortableFormatMigrationCampaign();
  const second = runPortableFormatMigrationCampaign();
  assert.deepEqual(first, second);
  assert.equal(first.boundary, 'disposable-temporary-workspace-only');
  assert.equal(first.sourcePreserved, true);
  assert.match(first.exactMigrationReceiptRoot, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(
    first.scenarios.map(({ id }) => id),
    [
      'preview',
      'no-op',
      'unsupported-refusal',
      'interruption-recovery',
      'success',
      'retry',
      'repair-refusal',
      'repair-success',
    ],
  );
  assert.equal(
    first.scenarios.find(({ id }) => id === 'unsupported-refusal')
      .writeOccurred,
    false,
  );
  assert.equal(
    first.scenarios.find(({ id }) => id === 'repair-refusal').writeOccurred,
    false,
  );
});
