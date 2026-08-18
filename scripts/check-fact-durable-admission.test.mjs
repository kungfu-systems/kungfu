#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPORT =
  'docs/qualification/evidence/fact-durable-admission/current-hardware-candidate-v1/report.json';
const read = (relative) => fs.readFileSync(path.join(ROOT, relative));
const readJson = (relative) => JSON.parse(read(relative));

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

const digestBytes = (value) =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;
const digestDocument = (value) =>
  digestBytes(Buffer.from(JSON.stringify(canonical(value))));

test('retained Fact durable admission evidence is exact and fail closed', () => {
  const contract = readJson(
    'framework/fact/kungfu-fact-cut-kernel.contract.json',
  );
  const report = readJson(REPORT);
  assert.equal(
    report.schema,
    'kungfu.fact.durable-admission-qualification-report/v1',
  );
  assert.equal(report.status, 'qualified-current-hardware-candidate');
  assert.equal(report.profile, contract.durableAdmission.predecessor.profile);
  assert.equal(report.contract.default_enabled, false);
  assert.equal(report.contract.production_eligible, false);
  assert.equal(contract.durableAdmission.defaultEnabled, true);
  assert.equal(contract.durableAdmission.productionEligible, true);
  assert.equal(
    contract.durableAdmission.productionEligibilityScope,
    'release-provenance-fact-cut-authority',
  );
  assert.equal(
    contract.durableAdmission.predecessor.status,
    'retained-evidence-only',
  );
  assert.equal(report.environment.platform, 'linux');
  assert.equal(report.environment.architecture, 'x64');
  assert.equal(
    report.environment.host_envelope,
    'agent120-linux-x64-ext4-nvme-fact-v1',
  );
  assert.equal(report.environment.filesystem, 'ext4');
  assert.match(report.environment.device, /nvme/u);

  const storageDirectory = 'framework/core/src/libkungfu/src/runtime/storage';
  const factStorageFiles = fs
    .readdirSync(path.join(ROOT, storageDirectory), { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /^fact_.*\.(?:cpp|h)$/u.test(entry.name),
    )
    .map((entry) => `${storageDirectory}/${entry.name}`)
    .sort();
  const retainedSourcePaths = report.source.files
    .map(({ path: sourcePath }) => sourcePath)
    .sort();
  for (const sourcePath of factStorageFiles)
    assert.equal(
      retainedSourcePaths.includes(sourcePath),
      true,
      `retained source closure excludes ${sourcePath}`,
    );
  assert.equal(
    retainedSourcePaths.includes(
      'framework/core/src/libkungfu/include/kungfu/runtime/storage/fact_kernel.h',
    ),
    true,
    'retained source closure excludes the public Fact Kernel interface',
  );

  for (const evidence of report.source.files) {
    assert.equal(typeof evidence.path, 'string');
    assert.match(evidence.sha256, /^sha256:[0-9a-f]{64}$/u);
  }
  assert.equal(
    digestDocument(report.source.files),
    report.source.source_set_root,
  );
  assert.match(
    report.underlying_durable_ingest.sha256,
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.match(report.checker.sha256, /^sha256:[0-9a-f]{64}$/u);

  const rootMaterial = structuredClone(report);
  rootMaterial.report_root = undefined;
  assert.equal(digestDocument(rootMaterial), report.report_root);
  assert.deepEqual(
    report.fault_campaign.cases.map(({ id, status }) => [id, status]),
    contract.durableAdmission.qualificationFaults.map((id) => [id, 'passed']),
  );
  assert.equal(report.fault_campaign.fresh_reopen, true);
  assert.equal(report.fault_campaign.result, 'passed');
  assert.equal(report.release_gate.gateId, 'durability.contracts');
  assert.equal(report.release_gate.task, 'test:durability-contract');
  assert.equal(report.residual_risks.length >= 4, true);
  assert.equal(report.non_claims.length >= 3, true);
});

test('native capability and fault suite project the machine contract', () => {
  const contract = readJson(
    'framework/fact/kungfu-fact-cut-kernel.contract.json',
  );
  const capabilitySource = read(
    'framework/core/src/libkungfu/src/runtime/storage/fact_query.cpp',
  ).toString();
  const implementation = read(
    'framework/core/src/libkungfu/src/runtime/storage/fact_durable_admission.cpp',
  ).toString();
  const platformDurability = read(
    'framework/core/src/libyijinjing/src/io/durability.cpp',
  ).toString();
  const characterization = read(
    'framework/core/tests/python/test_fact_kernel_characterization.py',
  ).toString();
  assert.match(capabilitySource, new RegExp(contract.durableAdmission.profile));
  assert.match(capabilitySource, /"default_enabled", true/u);
  assert.match(capabilitySource, /"production_eligible", true/u);
  assert.match(implementation, /sync_fact_journal/u);
  assert.match(implementation, /content_closure/u);
  assert.match(implementation, /verify_reconciled_authority/u);
  const windowsFileSync = platformDurability.match(
    /void sync_file\(const fs::path &path\) \{\n#ifdef _WIN32[\s\S]*?#else/u,
  )?.[0];
  assert.ok(windowsFileSync);
  assert.match(windowsFileSync, /CreateFileW[\s\S]*GENERIC_WRITE/u);
  assert.match(windowsFileSync, /FlushFileBuffers\(handle\)/u);
  assert.doesNotMatch(windowsFileSync, /O_RDONLY/u);
  for (const fault of contract.durableAdmission.qualificationFaults)
    assert.equal(characterization.includes(`"${fault}"`), true, fault);

  const gates = readJson('shifu.gates.json');
  const gate = gates.gates.find(
    ({ id }) => id === contract.durableAdmission.releaseGate.gateId,
  );
  assert.ok(gate);
  assert.equal(gate.action.task, contract.durableAdmission.releaseGate.task);
  const packageJson = readJson('package.json');
  assert.match(
    packageJson.scripts['test:durability-contract'],
    /run-durability-contract-tests/u,
  );
});
