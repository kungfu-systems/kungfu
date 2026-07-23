// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { POWER_CUT_FAULTS, createPowerCutPlan } from './powercut_plan.mjs';

const input = {
  runId: '12dd26e899-linux-ext4-v1',
  repo: '/data/worktrees/kungfu/feature/durability-qualification-final',
  sourceRevision: '2e22986eeefc048e61d48de437adc98dcecc9ac7',
  image: 'kungfu-linux-build-probe:conanfix-20260630T101847Z',
  kernelRelease: '6.8.0-134-generic',
  kernelVersion: '6.8.0-134.134',
};

test('power-cut plan is dry-run-only and names every fault boundary', () => {
  const plan = createPowerCutPlan(input);
  assert.equal(plan.mode, 'dry-run-only');
  assert.equal(plan.requires_explicit_confirmation, true);
  assert.equal(plan.trials.length, POWER_CUT_FAULTS.length * 2);
  assert.deepEqual(
    plan.trials
      .filter((trial) => trial.profile === 'durable_sync')
      .map((trial) => trial.fault),
    POWER_CUT_FAULTS.map(([fault]) => fault),
  );
  assert.equal(plan.safety.github_workflow, false);
  assert.doesNotMatch(
    JSON.stringify(plan),
    /self-hosted|workflow run|buildchain/iu,
  );
});

test('plan limits writes and termination to disposable run identities', () => {
  const plan = createPowerCutPlan(input);
  const mutating = plan.prepare.filter((step) => step.mutates);
  assert.ok(mutating.length > 0);
  assert.ok(
    mutating.every(
      (step) =>
        JSON.stringify(step).includes(plan.target.workspace) ||
        JSON.stringify(step).includes(plan.safety.disposable_container),
    ),
  );
  assert.ok(
    plan.trials.every(
      (trial) =>
        trial.reset[0].argv[0] === 'qemu-img' &&
        trial.reset[1].argv[0] === 'qemu-img' &&
        trial.write_rootfs !== trial.verify_rootfs &&
        trial.qemu_argv_prefix.some((argument) =>
          argument.includes('format=qcow2'),
        ) &&
        trial.qemu_argv_prefix.some(
          (argument) =>
            argument.includes('format=raw,cache=none,aio=native') &&
            argument.includes('-data.ext4'),
        ),
    ),
  );
  assert.equal(plan.safety.qemu_pid_must_be_direct_child, true);
  assert.ok(plan.trials.every((trial) => trial.termination.precondition));
  assert.ok(
    plan.trials.every((trial) => trial.verification_termination.precondition),
  );
  assert.equal(
    new Set(plan.trials.map((trial) => trial.pid_file)).size,
    plan.trials.length,
  );
  assert.ok(
    plan.trials.every((trial) =>
      trial.reset.every((step) =>
        step.argv.some((argument) => argument.includes(trial.id)),
      ),
    ),
  );
});

test('unsafe workspace or command inputs fail closed', () => {
  assert.throws(
    () => createPowerCutPlan({ ...input, runId: '../escape' }),
    /unsafe run id/,
  );
  assert.throws(
    () => createPowerCutPlan({ ...input, repo: '/tmp/kungfu' }),
    /must be below/,
  );
  assert.throws(
    () => createPowerCutPlan({ ...input, image: 'image; reboot' }),
    /unsafe container image/,
  );
});

test('checkpoint publication before directory sync remains an allowed range', () => {
  const plan = createPowerCutPlan(input);
  assert.deepEqual(
    plan.trials.find(
      (trial) =>
        trial.profile === 'durable_sync' &&
        trial.fault === 'after_checkpoint_rename',
    ).expected_durable_sequence,
    { minimum: 0, maximum: 1 },
  );
  assert.deepEqual(
    plan.trials.find(
      (trial) =>
        trial.profile === 'durable_sync' &&
        trial.fault === 'after_directory_sync',
    ).expected_durable_sequence,
    { minimum: 1, maximum: 1 },
  );
});
