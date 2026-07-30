// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..', '..', '..');
const runRoot = path.join(
  root,
  'docs',
  'qualification',
  'evidence',
  'durability',
  '791e09a70',
);
const evidenceRoot = path.join(runRoot, 'evidence');
const campaignRevision = '791e09a70780997347347bc4a7dae503c46cba11';
const qualificationRevision = '8fef5ad233ccb50c6fae7bb8ee167294f47a35db';

function sha256(pathname) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(pathname))
    .digest('hex');
}

function json(name) {
  return JSON.parse(fs.readFileSync(path.join(evidenceRoot, name), 'utf8'));
}

function requireTracked(pathname) {
  const relative = path.relative(root, pathname);
  assert.equal(
    execFileSync('git', ['ls-files', '--error-unmatch', relative], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    relative,
    `${relative} exists only as untracked local residue`,
  );
}

test('retained v2 campaign is complete, immutable, and hardware-bounded', () => {
  const reportPath = path.join(evidenceRoot, 'fault-campaign-v2.json');
  const rawPath = path.join(evidenceRoot, 'fault-campaign-v2.results.jsonl');
  const report = json('fault-campaign-v2.json');
  const raw = fs
    .readFileSync(rawPath, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));

  assert.equal(
    sha256(reportPath),
    '0ae769d3befabf3b382f5f116d638d68addafaedb6c263d7171369ff5bda0256',
  );
  assert.equal(
    sha256(rawPath),
    '018baa1d9cdf78392c9b79114fd2492dd3455ec0281241b68bfbdfa8e0e3ef4a',
  );
  assert.equal(report.source.revision, campaignRevision);
  assert.equal(report.source.dirty, false);
  assert.equal(report.verdict, 'passed');
  assert.deepEqual(report.counts, {
    required: 360,
    executed: 360,
    passed: 360,
    failed: 0,
  });
  assert.equal(report.integrity.raw_results_sha256, sha256(rawPath));
  assert.equal(report.integrity.raw_result_count, raw.length);
  assert.equal(raw.length, 360);
  assert.equal(new Set(raw.map((result) => result.id)).size, 360);
  assert.deepEqual(
    new Set(raw.map((result) => result.status)),
    new Set(['passed']),
  );
  assert.deepEqual(
    [...new Set(raw.map((result) => result.seed))].sort((a, b) => a - b),
    [104729, 130363, 155921],
  );
  assert.deepEqual([...new Set(raw.map((result) => result.envelope))].sort(), [
    'qcow2-none',
    'qcow2-writeback',
    'qcow2-writethrough',
    'raw-none',
    'raw-writeback',
    'raw-writethrough',
  ]);
  assert.equal(new Set(raw.map((result) => result.fault)).size, 10);
  assert.deepEqual([...new Set(raw.map((result) => result.profile))].sort(), [
    'durable_group',
    'durable_sync',
  ]);
  assert.deepEqual(report.claims, {
    complete_required_matrix: true,
    disposable_vm_device_model_campaign_qualified: true,
    repeated_seed_cycles_qualified: true,
    fresh_verification_boot_per_trial_qualified: true,
    physical_power_loss_qualified: false,
    physical_device_cache_qualified: false,
    production_profile_eligible: false,
    canary_only: false,
  });
  requireTracked(reportPath);
  requireTracked(rawPath);
});

test('retained canary cannot be promoted into qualification evidence', () => {
  const reportPath = path.join(evidenceRoot, 'fault-campaign-v2.canary.json');
  const rawPath = path.join(
    evidenceRoot,
    'fault-campaign-v2.canary.results.jsonl',
  );
  const report = json('fault-campaign-v2.canary.json');
  assert.equal(
    sha256(reportPath),
    'a85025b29e130574a5ac483169d0344f6c5782f02e6f331f60237a7bb058c2f5',
  );
  assert.equal(
    sha256(rawPath),
    'ebdacd84f225a5f5763c1585aebe90e95d4a5235c3b293c41a1cc281b8b7db20',
  );
  assert.equal(report.verdict, 'canary-passed');
  assert.equal(report.execution.execution_kind, 'non-qualifying-canary');
  assert.equal(report.counts.executed, 1);
  assert.equal(report.claims.canary_only, true);
  assert.equal(report.claims.complete_required_matrix, false);
  assert.equal(report.claims.production_profile_eligible, false);
  requireTracked(reportPath);
  requireTracked(rawPath);
});

test('current Linux process evidence retains every raw suite log', () => {
  const expected = new Map([
    [
      'durable_group',
      [
        'linux-ext4-process-durable_group-8fef5ad23.json',
        'c3e46857748db7f8943b7cedc57fd978d446245938a065ed012cbcdaf6c3e8d1',
      ],
    ],
    [
      'durable_sync',
      [
        'linux-ext4-process-durable_sync-8fef5ad23.json',
        'af097d2acbff86d8d787c96d5a455b86e5d29b65de6819945f2444faacf11998',
      ],
    ],
  ]);
  for (const [profile, [name, digest]] of expected) {
    const reportPath = path.join(evidenceRoot, name);
    const report = json(name);
    assert.equal(sha256(reportPath), digest);
    assert.equal(report.source.revision, qualificationRevision);
    assert.equal(report.source.dirty, false);
    assert.equal(report.durability_profile, profile);
    assert.equal(report.verdict, 'passed');
    assert.deepEqual(report.violations, []);
    assert.deepEqual(report.claims, {
      declared_process_envelope_qualified: true,
      power_loss_qualified: false,
      production_profile_eligible: false,
    });
    assert.equal(report.suites.length, 4);
    requireTracked(reportPath);
    for (const suite of report.suites) {
      assert.equal(suite.status, 'passed');
      assert.equal(suite.exit_code, 0);
      assert.deepEqual(suite.missing_markers, []);
      const rawPath = path.resolve(path.dirname(reportPath), suite.raw_log);
      assert.equal(rawPath.startsWith(`${evidenceRoot}${path.sep}`), true);
      assert.equal(sha256(rawPath), suite.raw_sha256);
      requireTracked(rawPath);
    }
  }
});

test('institutional drill proves same-host recovery without widening claims', () => {
  const name = 'single-host-institutional-qemu-8fef5ad23.json';
  const reportPath = path.join(evidenceRoot, name);
  const report = json(name);
  assert.equal(
    sha256(reportPath),
    '088a7148c539cab3af0a7e698cd6c8146cfb248c79e8debe095f69a415927620',
  );
  assert.equal(report.source.revision, qualificationRevision);
  assert.equal(report.source.dirty, false);
  assert.equal(report.verdict, 'passed');
  assert.deepEqual(report.claims, {
    real_enospc_no_false_ack_qualified: true,
    clean_unmount_whole_guest_reopen_qualified: true,
    repeated_whole_guest_recovery_qualified: true,
    offline_external_path_backup_restore_qualified: true,
    physical_host_restart_qualified: false,
    off_host_backup_qualified: false,
    independent_backup_failure_domain_qualified: false,
    production_profile_eligible: false,
  });
  assert.equal(report.results.repeated_whole_guest_recovery.length, 3);
  assert.ok(
    report.results.repeated_whole_guest_recovery.every(
      (result) =>
        result.verification.passed &&
        result.verification.durable_sequence === 1,
    ),
  );
  assert.equal(
    report.results.backup_restore.backup_sha256,
    report.results.backup_restore.restored_sha256,
  );
  assert.equal(report.results.backup_restore.before_backup_fsck.status, 0);
  assert.equal(report.results.backup_restore.after_restore_fsck.status, 0);
  assert.equal(
    report.results.backup_restore.restore_boot.verification.passed,
    true,
  );
  assert.equal(report.results.real_enospc.verification.passed, true);
  assert.equal(
    report.results.real_enospc.verification.durable_watermark_emitted,
    false,
  );
  assert.equal(
    report.results.real_enospc.verification.receipt_status,
    'unknown',
  );
  assert.equal(report.results.real_enospc_reopen.verification.passed, true);
  assert.equal(
    report.results.real_enospc_reopen.verification.durable_sequence,
    0,
  );

  const boots = [
    report.results.clean_write_and_unmount,
    ...report.results.repeated_whole_guest_recovery,
    report.results.backup_restore.restore_boot,
    report.results.real_enospc,
    report.results.real_enospc_reopen,
  ];
  for (const boot of boots) {
    assert.match(boot.serial_log, /^evidence\/[a-z0-9-]+\.serial\.log$/u);
    assert.match(boot.serial_log_sha256, /^[a-f0-9]{64}$/u);
  }
  requireTracked(reportPath);
  requireTracked(path.join(runRoot, 'README.md'));
});
