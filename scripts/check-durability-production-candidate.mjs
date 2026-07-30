// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceRoot = path.join(
  root,
  'docs/qualification/evidence/durability/production-candidate-v1',
);
const inputsPath = path.join(evidenceRoot, 'admission-inputs.json');
const reportPath = path.join(evidenceRoot, 'admission-report.json');
const jsonOutput = process.argv.slice(2).includes('--json');

assert.deepEqual(
  process.argv.slice(2).filter((arg) => arg !== '--json'),
  [],
  'usage: check-durability-production-candidate.mjs [--json]',
);

function sha256(pathname) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(pathname))
    .digest('hex');
}

function json(pathname) {
  return JSON.parse(fs.readFileSync(pathname, 'utf8'));
}

function trackedArtifact(relative) {
  assert.equal(
    path.isAbsolute(relative),
    false,
    `absolute artifact: ${relative}`,
  );
  const absolute = path.resolve(root, relative);
  assert.ok(
    absolute.startsWith(`${root}${path.sep}`),
    `artifact escapes repository: ${relative}`,
  );
  assert.equal(
    execFileSync('git', ['ls-files', '--error-unmatch', relative], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    relative,
    `artifact is not tracked: ${relative}`,
  );
  return absolute;
}

function validateSemanticEvidence(id, pathname) {
  if (id === 'live-durable-receipts') {
    const source = fs.readFileSync(pathname, 'utf8');
    assert.match(source, /ProductionCandidate/u);
    assert.match(source, /UnsupportedProfile/u);
    assert.match(source, /reconcile/u);
    return;
  }
  if (id === 'projection-authority-candidate') {
    const source = fs.readFileSync(pathname, 'utf8');
    assert.match(source, /Required/u);
    assert.match(source, /Optional/u);
    assert.match(source, /production_eligible/u);
    assert.match(source, /rollback/u);
    return;
  }

  const evidence = json(pathname);
  if (id === 'agent120-fault-campaign') {
    assert.equal(evidence.verdict, 'passed');
    assert.equal(evidence.counts.required, 360);
    assert.equal(evidence.counts.passed, 360);
    assert.equal(evidence.claims.complete_required_matrix, true);
    assert.equal(evidence.claims.physical_power_loss_qualified, false);
    assert.equal(evidence.claims.production_profile_eligible, false);
  } else if (id === 'agent120-durability-slo') {
    assert.equal(evidence.verdict, 'passed-candidate-slo');
    assert.equal(evidence.results.length, 8);
    assert.equal(evidence.violations.length, 0);
    assert.equal(evidence.claims.absolute_candidate_slo, true);
    assert.equal(evidence.claims.production_eligible, false);
  } else if (id === 'same-office-offhost-restore') {
    assert.equal(evidence.verdict, 'passed-candidate-offhost-restore');
    assert.equal(evidence.off_host_verified, true);
    assert.equal(evidence.same_office, true);
    assert.equal(evidence.independent_failure_domain_qualified, false);
    assert.equal(evidence.production_eligible, false);
  } else if (id === 'agent120-clean-host-restart') {
    assert.equal(evidence.verdict, 'passed-candidate-clean-host-restart');
    assert.equal(evidence.boot_id_changed, true);
    assert.equal(evidence.clean_host_restart_qualified, true);
    assert.equal(evidence.physical_power_loss_qualified, false);
    assert.equal(evidence.production_eligible, false);
  } else {
    assert.fail(`unknown admission input: ${id}`);
  }
}

const requiredIds = [
  'live-durable-receipts',
  'projection-authority-candidate',
  'agent120-fault-campaign',
  'agent120-durability-slo',
  'same-office-offhost-restore',
  'agent120-clean-host-restart',
];
const inputs = json(inputsPath);
assert.equal(inputs.schema, 'kungfu.durability-production-candidate-inputs/v1');
assert.equal(
  inputs.profile,
  'single-host-institutional-production-candidate-v1',
);
assert.match(inputs.baseline_dev_sha, /^[a-f0-9]{40}$/u);
assert.deepEqual(
  inputs.inputs.map((input) => input.id),
  requiredIds,
);

for (const input of inputs.inputs) {
  assert.equal(input.qualification, 'passed');
  assert.match(input.implementation_sha, /^[a-f0-9]{40}$/u);
  assert.match(input.delivery_sha, /^[a-f0-9]{40}$/u);
  assert.match(
    input.pull_request,
    /^https:\/\/github\.com\/kungfu-systems\/kungfu\/pull\/[0-9]+$/u,
  );
  assert.match(input.rerun, /^\.\/shifu /u);
  assert.ok(input.environment.length > 0);
  assert.ok(
    ['source-bound', 'environment-bound-retained'].includes(
      input.freshness.mode,
    ),
  );
  assert.ok(input.freshness.invalidated_by.includes('artifact-digest-drift'));
  assert.equal(input.artifacts.length, 1);
  const artifact = input.artifacts[0];
  const pathname = trackedArtifact(artifact.path);
  assert.equal(sha256(pathname), artifact.sha256, `${input.id} digest drift`);
  validateSemanticEvidence(input.id, pathname);
}

const report = json(reportPath);
assert.equal(report.schema, 'kungfu.durability-production-candidate-report/v1');
assert.equal(report.verdict, 'passed-current-hardware-production-candidate');
assert.equal(report.authority, 'libkungfu');
assert.equal(report.profile, inputs.profile);
assert.equal(report.baseline_dev_sha, inputs.baseline_dev_sha);
assert.equal(report.inputs_sha256, sha256(inputsPath));
assert.deepEqual(report.admitted_inputs, requiredIds);
assert.deepEqual(report.subsystems, {
  durable_receipts: 'default-off-candidate',
  projection_authority: 'default-off-candidate',
  episode_recovery: 'candidate-qualified',
  storage_backup_restore: 'same-office-offhost-qualified',
});
assert.deepEqual(report.claims, {
  current_hardware_candidate_complete: true,
  candidate_profile_default_enabled: false,
  clean_host_restart_qualified: true,
  off_host_restore_qualified: true,
  physical_power_loss_qualified: false,
  independent_failure_domain_qualified: false,
  production_eligible: false,
  high_availability_supported: false,
  replication_supported: false,
  consensus_supported: false,
});
assert.equal(
  report.freshness_policy,
  'fail-closed-on-source-artifact-or-environment-drift',
);
assert.equal(
  report.compatibility_bridge,
  'retained-until-production-qualified',
);

const result = {
  schema: report.schema,
  verdict: report.verdict,
  profile: report.profile,
  inputs_sha256: report.inputs_sha256,
  report_sha256: sha256(reportPath),
  admitted_input_count: report.admitted_inputs.length,
  production_eligible: report.claims.production_eligible,
};

if (jsonOutput) console.log(JSON.stringify(result, null, 2));
else
  console.log(
    `[durability-admission] ${result.verdict}; inputs=${result.admitted_input_count}; production_eligible=false`,
  );
