// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { createPowerCutPlan } from '@kungfu-tech/core/testing/qualification/durability/powercut_plan';
import { preparationView } from './prepare-durability-powercut-qemu.mjs';

const input = {
  runId: 'candidate-v2',
  repo: '/home/dkr/Worktrees/kungfu/feature/agent120-fault-campaign',
  sourceRevision: '19aab0b6033bb2e7431223b7cfcd62de126da77c',
  image: 'kungfu-linux-build-probe:conanfix-20260630T101847Z',
  kernelRelease: '6.8.0-134-generic',
  kernelVersion: '6.8.0-134.134',
};

test('preparation remains dry-run and run-scoped by default', () => {
  const view = preparationView(createPowerCutPlan(input));
  assert.equal(view.mode, 'dry-run');
  assert.equal(
    view.safety.creates_only_below,
    '/data/qualification/kungfu/durability/candidate-v2',
  );
  assert.equal(view.safety.physical_device_write, false);
  assert.equal(view.safety.physical_host_restart, false);
  assert.match(view.safety.cleanup, /not performed/u);
  assert.ok(
    view.steps.some((step) => step.id === 'install-workspace-sentinel'),
  );
});

test('preparation implementation has no workflow or host-service authority', () => {
  const source = fs.readFileSync(
    new URL('./prepare-durability-powercut-qemu.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /refusing existing workspace/u);
  assert.match(source, /source worktree must be clean/u);
  assert.doesNotMatch(
    source,
    /gh workflow|workflow_dispatch|self-hosted|systemctl|reboot|sudo/iu,
  );
});
