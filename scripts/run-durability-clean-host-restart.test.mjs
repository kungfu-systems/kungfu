import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  buildPlan,
  loadProfile,
  normalizedArchitecture,
} from './run-durability-clean-host-restart.mjs';

function portablePath(value) {
  return value.replaceAll('\\', '/');
}

test('clean-restart plan is frozen, sentinel-protected, and two-phase', () => {
  const profile = loadProfile();
  const prepare = buildPlan(profile, 'clean-restart-contract-v1', 'prepare');
  const verify = buildPlan(profile, 'clean-restart-contract-v1', 'verify');
  assert.equal(prepare.profile, 'linux-agent120-clean-restart-v1');
  assert.equal(
    portablePath(prepare.workspace),
    '/data/qualification/kungfu/clean-host-restart/clean-restart-contract-v1',
  );
  assert.equal(prepare.phase, 'prepare');
  assert.equal(verify.phase, 'verify');
  assert.equal(prepare.resume_token, verify.resume_token);
  assert.equal(prepare.claims.clean_host_restart_qualified, true);
  assert.equal(prepare.claims.physical_power_loss_qualified, false);
  assert.equal(prepare.claims.production_eligible, false);
});

test('unsafe run identities and phases fail before any host operation', () => {
  const profile = loadProfile();
  assert.throws(
    () => buildPlan(profile, '../../escape'),
    /unsafe or missing --run-id/,
  );
  assert.throws(
    () => buildPlan(profile, 'clean-restart-contract-v1', 'reboot'),
    /--phase must be prepare or verify/,
  );
});

test('Node architecture names normalize to the frozen Linux vocabulary', () => {
  assert.equal(normalizedArchitecture('x64'), 'x86_64');
  assert.equal(normalizedArchitecture('arm64'), 'aarch64');
});

test('runner contains no CI, deletion, or host-control authority', () => {
  const source = fs.readFileSync(
    new URL('./run-durability-clean-host-restart.mjs', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /self-hosted|workflow_dispatch|gh run|systemctl|shutdown|sudo|rm -rf|rsync[^\n]*--delete/,
  );
  assert.doesNotMatch(
    source,
    /run\(['"](?:reboot|shutdown|systemctl|sudo)['"]/,
  );
  assert.match(source, /\/proc\/sys\/kernel\/random\/boot_id/);
  assert.match(source, /fs\.fsyncSync\(descriptor\)/);
  assert.match(source, /after\.generation <= before\.generation/);
});
