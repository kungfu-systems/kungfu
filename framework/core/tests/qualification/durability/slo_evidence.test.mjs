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
const evidencePath = path.join(
  root,
  'docs/qualification/evidence/durability/070e0804b/agent120-durability-slo-v1.json',
);
const profilePath = path.join(
  root,
  'framework/core/tests/qualification/durability/profiles/linux-ext4-agent120-slo-v1.json',
);

function sha256(pathname) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(pathname))
    .digest('hex');
}

test('retained agent-120 SLO index is immutable and profile-bound', () => {
  assert.equal(
    sha256(evidencePath),
    'bd5497228f51eaea6c38e3e82bb07a7bfb549d6969da03b4bfb0d421511a232e',
  );
  const evidence = JSON.parse(fs.readFileSync(evidencePath));
  assert.equal(evidence.verdict, 'passed-candidate-slo');
  assert.equal(evidence.results.length, 8);
  assert.ok(evidence.results.every((result) => result.violations.length === 0));
  assert.equal(evidence.profile.sha256, sha256(profilePath));
  assert.equal(
    evidence.retained_machine_artifacts.raw_results.sha256,
    '288cc7ea14100fbc17415143084ad9610ed92b1600521fb6ecd6b8e571bc9a58',
  );
});

test('candidate SLO evidence cannot widen hardware or production claims', () => {
  const evidence = JSON.parse(fs.readFileSync(evidencePath));
  assert.equal(evidence.host.hostname, 'agent-120');
  assert.equal(evidence.host.filesystem, 'ext4');
  assert.match(evidence.host.device_source, /nvme/u);
  assert.equal(evidence.claims.comparator_used, false);
  assert.equal(evidence.claims.cross_platform_qualified, false);
  assert.equal(evidence.claims.mmap_visible_path_qualified, false);
  assert.equal(evidence.claims.physical_power_loss_qualified, false);
  assert.equal(evidence.claims.off_host_backup_qualified, false);
  assert.equal(evidence.claims.production_eligible, false);
});
