// SPDX-License-Identifier: Apache-2.0
// @ts-check

import crypto from 'node:crypto';
import fs from 'node:fs';

const PROFILE_URL = new URL(
  './profiles/linux-ext4-qemu-fault-campaign-v2.json',
  import.meta.url,
);

export function loadFaultCampaignProfile() {
  return JSON.parse(fs.readFileSync(PROFILE_URL, 'utf8'));
}

export function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableJson(item)]),
    );
  }
  return value;
}

export function sha256Json(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(stableJson(value)))
    .digest('hex');
}

function seededOrder(items, seed) {
  let state = seed >>> 0;
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const selected = state % (index + 1);
    [result[index], result[selected]] = [result[selected], result[index]];
  }
  return result;
}

export function createFaultCampaignMatrix(
  profile = loadFaultCampaignProfile(),
) {
  if (profile.schema !== 'kungfu.durability.fault-campaign-profile/v2') {
    throw new Error(`unsupported fault campaign schema: ${profile.schema}`);
  }
  if (new Set(profile.seeds).size !== profile.required_cycles) {
    throw new Error('fault campaign seeds must exactly match required cycles');
  }
  const base = profile.durability_profiles.flatMap((durabilityProfile) =>
    profile.device_envelopes.flatMap((envelope) =>
      profile.faults.map((fault) => ({
        profile: durabilityProfile,
        fault: fault.name,
        expected_durable_sequence: {
          minimum: fault.minimum,
          maximum: fault.maximum,
        },
        envelope: envelope.id,
        data_format: envelope.data_format,
        cache_mode: envelope.cache_mode,
        aio_mode: envelope.aio_mode,
      })),
    ),
  );
  const trials = profile.seeds.flatMap((seed, cycle) =>
    seededOrder(base, seed).map((trial) => ({
      ...trial,
      seed,
      cycle: cycle + 1,
      id: `c${cycle + 1}-${trial.profile === 'durable_group' ? 'dg' : 'ds'}-${trial.envelope}-${trial.fault}`,
      arm_marker: `KF_POWER_CUT_ARMED fault=${trial.fault} sequence=1`,
    })),
  );
  if (trials.length !== profile.expected_trial_count) {
    throw new Error(
      `fault campaign expected ${profile.expected_trial_count} trials, produced ${trials.length}`,
    );
  }
  if (new Set(trials.map((trial) => trial.id)).size !== trials.length) {
    throw new Error('fault campaign trial ids must be unique');
  }
  return {
    schema: 'kungfu.durability.fault-campaign-matrix/v2',
    profile,
    profile_digest: sha256Json(profile),
    trial_count: trials.length,
    trials,
    claims: {
      physical_power_loss_qualified: false,
      physical_device_cache_qualified: false,
      production_profile_eligible: false,
    },
  };
}
