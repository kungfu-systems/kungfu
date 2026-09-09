// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const report = JSON.parse(
  fs.readFileSync(
    new URL(
      import.meta.resolve(
        '@kungfu-tech/workspaces/testing/durability-institutional-profile',
      ),
    ),
    'utf8',
  ),
);

test('institutional evidence binds every correctness tier', () => {
  assert.equal(
    report.schema,
    'kungfu.durability.single-host-institutional-profile/v1',
  );
  assert.equal(report.source.dirty, false);
  assert.equal(report.evidence.process_crash_matrix.passed, 6);
  assert.equal(report.evidence.disposable_vm_power_cut_matrix.passed, 20);
  assert.equal(
    report.evidence.institutional_qemu_drill.real_enospc.passed,
    true,
  );
  assert.equal(
    report.evidence.institutional_qemu_drill.offline_backup_restore
      .fresh_restore_boot_passed,
    true,
  );
  assert.equal(report.evidence.episode_load.qualified, true);
  assert.deepEqual(
    Object.values(report.evidence.episode_load.correctness),
    Array(7).fill(0),
  );
});

test('institutional evidence cannot imply physical or production qualification', () => {
  assert.equal(report.non_claims.physical_host_restart_qualified, false);
  assert.equal(report.non_claims.physical_power_loss_qualified, false);
  assert.equal(report.non_claims.off_host_backup_qualified, false);
  assert.equal(report.non_claims.production_profile_eligible, false);
  assert.equal(report.non_claims.absolute_performance_slo_qualified, false);
});
