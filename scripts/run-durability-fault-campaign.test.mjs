// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { createFaultCampaignPlan } from './run-durability-fault-campaign.mjs';
import { dataDriveArgument } from './run-durability-powercut-qemu.mjs';

const input = {
  workspace: '/data/qualification/kungfu/durability/candidate-v2',
  rootfsBase:
    '/data/qualification/kungfu/durability/candidate-v2/rootfs-base.ext4',
  report:
    '/data/qualification/kungfu/durability/candidate-v2/evidence/campaign.json',
  rawResults:
    '/data/qualification/kungfu/durability/candidate-v2/evidence/results.jsonl',
  sourceRevision: '19aab0b6033bb2e7431223b7cfcd62de126da77c',
  kernelRelease: '6.8.0-134-generic',
};

test('campaign dry run names the full bounded mutation surface', () => {
  const plan = createFaultCampaignPlan(input);
  assert.equal(plan.mode, 'dry-run');
  assert.equal(plan.matrix.trial_count, 360);
  assert.equal(plan.matrix.required_cycles, 3);
  assert.equal(plan.safety.github_workflow, false);
  assert.equal(plan.safety.physical_device_write, false);
  assert.equal(plan.safety.physical_host_restart, false);
  assert.equal(plan.safety.failed_campaign_workspace_is_not_reused, true);
  assert.match(plan.safety.cleanup, /not performed/u);
});

test('canary is one named trial and cannot claim qualification', () => {
  const canaryTrial = 'c1-dg-qcow2-writeback-after_data_sync';
  const plan = createFaultCampaignPlan({ ...input, canaryTrial });
  assert.equal(plan.execution_kind, 'non-qualifying-canary');
  assert.deepEqual(plan.matrix.selected_trials, [canaryTrial]);
  assert.equal(plan.safety.canary_is_never_qualification_evidence, true);
  assert.equal(plan.matrix.trial_count, 360);
  assert.throws(
    () => createFaultCampaignPlan({ ...input, canaryTrial: 'not-a-trial' }),
    /unknown canary trial/u,
  );
});

test('QEMU device envelopes are explicit and do not widen hardware claims', () => {
  assert.equal(
    dataDriveArgument({
      data: '/tmp/data.ext4',
      dataFormat: 'raw',
      cacheMode: 'none',
    }),
    'if=virtio,format=raw,cache=none,aio=native,file=/tmp/data.ext4',
  );
  assert.equal(
    dataDriveArgument({
      data: '/tmp/data.qcow2',
      dataFormat: 'qcow2',
      cacheMode: 'writeback',
    }),
    'if=virtio,format=qcow2,cache=writeback,aio=threads,file=/tmp/data.qcow2',
  );
});

test('campaign source records every failure and preserves the workspace', () => {
  const source = fs.readFileSync(
    new URL('./run-durability-fault-campaign.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /appendRaw\(rawFd, result\)/u);
  assert.match(source, /fs\.fsyncSync\(fd\)/u);
  assert.match(source, /failed_campaign_workspace_is_not_reused/u);
  assert.match(source, /physical_power_loss_qualified: false/u);
  assert.doesNotMatch(source, /gh workflow|workflow_dispatch|self-hosted/iu);
});
