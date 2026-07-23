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
  'docs/qualification/evidence/durability/987201493',
);
const expectedDigests = {
  'aggregate-report.json':
    '4034b2653c1acd5f1b1608d7e68c3328f91fa501c04f180252c4f22e232bc574',
  'complete.json':
    'a08ca3e356c4e1ee650d1337663fcb11c7944fbfa408a12b439d2bb8186b957b',
  'manifest.json':
    '049aa86a0d63be989c54261ec2b246dada8d97fd10751e45232ebc56c6e9d42e',
  'restore-report.json':
    '476e78aec85d3c1a8180cb69495dd9926fb37097b85faf7a90c6ded4301576db',
  'source-report.json':
    '0506f956cfac122bb28a10c196a94c94cb994d9838c94b53b60b47d085f8d93e',
  'verify-report.json':
    'b2f9cc3580821554f8735ee718ce4fffa6cc1dc42589428a2c274f6398fec274',
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

test('retained off-host reports are exact machine artifacts', () => {
  for (const [name, digest] of Object.entries(expectedDigests)) {
    assert.equal(sha256(path.join(evidenceRoot, name)), digest);
  }
  assert.equal(
    sha256(
      path.join(
        root,
        'framework/core/tests/qualification/durability/profiles/linux-agent120-ubuntu222-offhost-v1.json',
      ),
    ),
    'ae0d8a63ea2af57366b3e506a8223acad0ab5d1a70d12b454dda0e995717f3d1',
  );
});

test('off-host restore preserves authoritative facts and stays bounded', () => {
  const aggregate = report('aggregate-report.json');
  const source = report('source-report.json');
  const verify = report('verify-report.json');
  const restore = report('restore-report.json');
  const manifest = report('manifest.json');
  const complete = report('complete.json');

  assert.equal(aggregate.verdict, 'passed-candidate-offhost-restore');
  assert.equal(aggregate.source_hostname, 'agent-120');
  assert.equal(aggregate.target_hostname, 'Kerens-MoreFine');
  assert.equal(aggregate.interrupted_transfer_rejected, true);
  assert.equal(aggregate.partial_directory_retained, true);
  assert.equal(aggregate.repeated_restore_idempotent, true);
  assert.equal(aggregate.off_host_verified, true);
  assert.equal(aggregate.same_office, true);
  assert.equal(aggregate.independent_failure_domain_qualified, false);
  assert.equal(aggregate.physical_power_loss_qualified, false);
  assert.equal(aggregate.production_eligible, false);

  assert.equal(source.bundle_id, aggregate.bundle_id);
  assert.deepEqual(restore.records, source.records);
  assert.deepEqual(restore.restored_cut, source.backup_cut);
  assert.deepEqual(restore.projection_cut, source.projection_cut);
  assert.deepEqual(restore.projection_state, source.projection_state);
  assert.equal(
    restore.projection_integrity_sha256,
    aggregate.projection_integrity_sha256,
  );
  assert.equal(restore.episodes.length, 1);
  assert.equal(restore.episodes[0].status, 'ok');
  assert.equal(verify.complete, true);
  assert.equal(manifest.files.length, 5);
  assert.equal(manifest.lost_visible_tail_bytes, 0);
  assert.equal(complete.manifest_sha256, aggregate.manifest_sha256);
});
