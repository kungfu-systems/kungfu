// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFaultCampaignMatrix,
  loadFaultCampaignProfile,
} from './fault_campaign.mjs';

test('fault campaign freezes three complete seeded device-model cycles', () => {
  const profile = loadFaultCampaignProfile();
  const matrix = createFaultCampaignMatrix(profile);
  assert.equal(matrix.trial_count, 360);
  assert.equal(matrix.profile_digest.length, 64);
  assert.equal(new Set(matrix.trials.map((trial) => trial.id)).size, 360);
  assert.deepEqual(
    new Set(matrix.trials.map((trial) => trial.seed)),
    new Set(profile.seeds),
  );
  for (const seed of profile.seeds) {
    const cycle = matrix.trials.filter((trial) => trial.seed === seed);
    assert.equal(cycle.length, 120);
    assert.deepEqual(
      new Set(cycle.map((trial) => trial.envelope)),
      new Set(profile.device_envelopes.map((envelope) => envelope.id)),
    );
    assert.deepEqual(
      new Set(cycle.map((trial) => trial.fault)),
      new Set(profile.faults.map((fault) => fault.name)),
    );
  }
});

test('fault campaign order is deterministic and claims stay bounded', () => {
  const first = createFaultCampaignMatrix();
  const second = createFaultCampaignMatrix();
  assert.deepEqual(
    first.trials.map((trial) => trial.id),
    second.trials.map((trial) => trial.id),
  );
  assert.equal(first.claims.physical_power_loss_qualified, false);
  assert.equal(first.claims.physical_device_cache_qualified, false);
  assert.equal(first.claims.production_profile_eligible, false);
});

test('fault campaign rejects profile cardinality drift', () => {
  const profile = loadFaultCampaignProfile();
  assert.throws(
    () =>
      createFaultCampaignMatrix({
        ...profile,
        expected_trial_count: profile.expected_trial_count + 1,
      }),
    /expected 361 trials/u,
  );
});
