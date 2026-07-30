// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);
const evidenceRoot = path.join(
  root,
  'docs/qualification/evidence/durability/17e807700',
);
const expectedDigests = {
  'aggregate-report.json':
    '7d377977a3bae516624cd1f9d6656e7f2c54b37eb9cef59b77ee68e979c4acb6',
  'post-report.json':
    '9634399abb7e4df8d50fecc08529ccdb62052bb2d3b351383506f80a0a607271',
  'pre-report.json':
    'c3360ff114d9ec1aa556316574279edb6128f8955f44adf7e2429ec7eed93459',
  'resume.json':
    '207c24f4ecaccd6b1cb2eabdd18b6e608aa3b13ad162ccbe0a64eaea530f4fc0',
};

function sha256(pathname) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(pathname))
    .digest('hex');
}

function report(name) {
  return JSON.parse(fs.readFileSync(path.join(evidenceRoot, name), 'utf8'));
}

test('retained clean-restart reports are exact machine artifacts', () => {
  for (const [name, digest] of Object.entries(expectedDigests)) {
    assert.equal(sha256(path.join(evidenceRoot, name)), digest);
  }
  assert.equal(
    sha256(
      path.join(
        root,
        'framework/core/tests/qualification/durability/profiles/linux-agent120-clean-restart-v1.json',
      ),
    ),
    'afb64ac2963727ccff94b897918d65b4ef3925fa5eb295dc3857273b727d5057',
  );
});

test('clean host restart preserves authority and cannot widen its claim', () => {
  const aggregate = report('aggregate-report.json');
  const before = report('pre-report.json');
  const token = report('resume.json');
  const after = report('post-report.json');

  assert.equal(aggregate.verdict, 'passed-candidate-clean-host-restart');
  assert.equal(aggregate.source_sha, token.source_sha);
  assert.equal(aggregate.boot_id_before, token.boot_id_before);
  assert.notEqual(aggregate.boot_id_after, aggregate.boot_id_before);
  assert.equal(aggregate.boot_id_changed, true);
  assert.ok(
    aggregate.restart_elapsed_seconds <= aggregate.restart_limit_seconds,
  );
  assert.equal(aggregate.clean_host_restart_qualified, true);
  assert.equal(aggregate.physical_power_loss_qualified, false);
  assert.equal(aggregate.production_eligible, false);

  assert.deepEqual(after.durable_frontier, before.backup_cut);
  assert.equal(after.durable_record_count, before.durable_record_count);
  assert.deepEqual(after.records, before.records);
  assert.deepEqual(after.projection_state, before.projection_state);
  assert.deepEqual(after.projection_cut, before.projection_cut);
  assert.equal(
    after.projection_integrity_sha256,
    before.projection_integrity_sha256,
  );
  assert.equal(after.unacknowledged_tail_bytes, 0);
  assert.equal(after.episodes.length, 1);
  assert.equal(after.episodes[0].status, 'ok');
  assert.equal(after.episodes[0].lifecycle, 'ended');
  assert.equal(after.recovery_outcome, 'ready');
  assert.equal(after.projection_outcome, 'ready');
  assert.equal(after.fresh_process_reopen_verified, true);
  assert.equal(after.clean_host_restart_qualified, false);

  for (const scope of ['service', 'writer']) {
    assert.ok(
      aggregate.ownership_generation_after[scope] >
        aggregate.ownership_generation_before[scope],
    );
    assert.equal(after.ownership[scope].owned, true);
    assert.equal(after.ownership[scope].recovered_stale_owner, false);
  }
  assert.deepEqual(aggregate.startup_order_verified, [
    'host_boot',
    'filesystem_mount',
    'state_service_owner',
    'durable_recovery',
    'projection_bootstrap',
    'required_peers',
  ]);
});
