import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPlan,
  loadProfile,
  normalizedArchitecture,
} from './run-durability-offhost-restore.mjs';

function portablePath(value) {
  return value.replaceAll('\\', '/');
}

test('off-host plan is frozen, build-local, sentinel-protected, and delete-free', () => {
  const profile = loadProfile();
  const plan = buildPlan(profile, 'offhost-contract-test-v1');
  assert.equal(plan.profile, 'linux-agent120-ubuntu222-offhost-v1');
  assert.match(
    portablePath(plan.source.workspace),
    /framework\/core\/build\/qualification\/durability-offhost/,
  );
  assert.equal(
    plan.target.root,
    '/data/qualification/kungfu/offhost-backup-restore',
  );
  assert.equal(
    plan.target.sentinel,
    `${plan.target.root}/.kungfu-offhost-backup-target`,
  );
  assert.equal(plan.transport.delete_allowed, false);
  assert.equal(plan.transport.argv_prefix.includes('--delete'), false);
  assert.equal(plan.claims.off_host_verified, true);
  assert.equal(plan.claims.independent_failure_domain_qualified, false);
  assert.equal(plan.claims.physical_power_loss_qualified, false);
  assert.equal(plan.claims.production_eligible, false);
});

test('unsafe run identities fail before any host operation', () => {
  const profile = loadProfile();
  assert.throws(
    () => buildPlan(profile, '../../escape'),
    /unsafe or missing --run-id/,
  );
  assert.throws(
    () => buildPlan(profile, 'short'),
    /unsafe or missing --run-id/,
  );
});

test('Node architecture names normalize to the frozen Linux hardware vocabulary', () => {
  assert.equal(normalizedArchitecture('x64'), 'x86_64');
  assert.equal(normalizedArchitecture('arm64'), 'aarch64');
  assert.equal(normalizedArchitecture('riscv64'), 'riscv64');
});

test('runner contains no self-hosted CI, deletion, or host-service authority', async () => {
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(
      new URL('./run-durability-offhost-restore.mjs', import.meta.url),
      'utf8',
    ),
  );
  assert.doesNotMatch(
    source,
    /self-hosted|workflow_dispatch|gh run|rsync[^\n]*--delete|systemctl|sudo|rm -rf/,
  );
  assert.match(source, /run\('findmnt', \[\s*'-T',\s*ROOT,/);
  assert.match(source, /findmnt -T \$\{shellQuote\(profile\.target\.root\)\}/);
});
