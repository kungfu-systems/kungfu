// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type KfxContract, validateKfxProfileSuite } from './index';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);
const fixtureRoot = path.join(
  root,
  'tests',
  'fixtures',
  'kfx-profile-suite-contract',
);
const contract = JSON.parse(
  readFileSync(
    path.join(root, 'framework/kfx/kungfu-kfx.contract.json'),
    'utf8',
  ),
) as KfxContract;
const validProfile = JSON.parse(
  readFileSync(path.join(fixtureRoot, 'week-day.profile.json'), 'utf8'),
) as Record<string, unknown>;
const invalidCases = JSON.parse(
  readFileSync(path.join(fixtureRoot, 'invalid-cases.json'), 'utf8'),
) as Array<{
  id: string;
  operation: 'set' | 'remove';
  path: string[];
  value?: unknown;
}>;

function applyCase(
  profile: Record<string, unknown>,
  fixture: (typeof invalidCases)[number],
): void {
  let target = profile;
  for (const segment of fixture.path.slice(0, -1)) {
    target = target[segment] as Record<string, unknown>;
  }
  const leaf = fixture.path.at(-1) as string;
  if (fixture.operation === 'remove') delete target[leaf];
  else target[leaf] = fixture.value;
}

test('Node validates the complete Week/Day Profile Suite closure', () => {
  validateKfxProfileSuite(validProfile, contract, [
    'week-day-contract',
    'week-day-actions',
    'week-day-assessment',
    'week-day-dashboard',
  ]);
});

for (const fixture of invalidCases) {
  test(`Node rejects Profile Suite fixture: ${fixture.id}`, () => {
    const profile = structuredClone(validProfile);
    applyCase(profile, fixture);
    assert.throws(() => validateKfxProfileSuite(profile, contract));
  });
}

test('Node rejects Profile Suite package-member drift', () => {
  assert.throws(
    () =>
      validateKfxProfileSuite(validProfile, contract, [
        'week-day-contract',
        'week-day-actions',
      ]),
    /must match kungfuConfig\.suite\.members/,
  );
});
