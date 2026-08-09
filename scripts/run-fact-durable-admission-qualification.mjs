#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = 'fact-durable-admission/current-hardware-candidate-v1';
const CONTRACT = 'framework/fact/kungfu-fact-cut-kernel.contract.json';
const TEST = 'framework/core/tests/python/test_fact_kernel_characterization.py';
const SOURCE_PATHS = [
  CONTRACT,
  'framework/fact/kungfu-fact-root-canonical-v2.json',
  'framework/core/architecture/TARGETS.cmake',
  'framework/core/src/libkungfu/include/kungfu/runtime/storage/fact_kernel.h',
  'framework/core/src/libkungfu/src/runtime/storage/fact_actions.cpp',
  'framework/core/src/libkungfu/src/runtime/storage/fact_actions.h',
  'framework/core/src/libkungfu/src/runtime/storage/fact_authority.cpp',
  'framework/core/src/libkungfu/src/runtime/storage/fact_authority.h',
  'framework/core/src/libkungfu/src/runtime/storage/fact_commit.cpp',
  'framework/core/src/libkungfu/src/runtime/storage/fact_domain.cpp',
  'framework/core/src/libkungfu/src/runtime/storage/fact_domain.h',
  'framework/core/src/libkungfu/src/runtime/storage/fact_durable_admission.cpp',
  'framework/core/src/libkungfu/src/runtime/storage/fact_kernel.cpp',
  'framework/core/src/libkungfu/src/runtime/storage/fact_kernel_internal.h',
  'framework/core/src/libkungfu/src/runtime/storage/fact_portability.cpp',
  'framework/core/src/libkungfu/src/runtime/storage/fact_protocol.cpp',
  'framework/core/src/libkungfu/src/runtime/storage/fact_query.cpp',
  'framework/core/src/libkungfu/src/runtime/storage/fact_state.cpp',
  TEST,
  'framework/contract/kungfu-agent-first-canonical-policy.json',
  'framework/contract/kungfu-contracts.registry.json',
  'package.json',
  'scripts/check-fact-durable-admission.test.mjs',
  'scripts/run-durability-contract-tests.mjs',
  'scripts/run-fact-durable-admission-qualification.mjs',
  'shifu.gates.json',
];

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

function digestBytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function digestDocument(value) {
  return digestBytes(Buffer.from(JSON.stringify(canonical(value))));
}

function fileEvidence(relative) {
  const absolute = path.join(ROOT, relative);
  return {
    path: relative,
    sha256: digestBytes(fs.readFileSync(absolute)),
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0 || index + 1 >= argv.length)
    throw new Error(`${name} is required`);
  return argv[index + 1];
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for retained qualification`);
  return value;
}

function main() {
  const output = option(process.argv.slice(2), '--output');
  const repositoryBindingDirectory = path.join(
    ROOT,
    'framework',
    'core',
    'build',
    'Release',
  );
  const bindingDirectory = path.resolve(
    process.env.KUNGFU_FACT_QUALIFICATION_BINDING_DIR ||
      repositoryBindingDirectory,
  );
  const binding = fs
    .readdirSync(bindingDirectory)
    .find((name) => /^pykungfu.*\.(so|pyd)$/u.test(name));
  if (!binding)
    throw new Error(
      'native pykungfu binding is absent; run ./shifu build:core',
    );

  const pythonPath = [
    path.join(ROOT, 'framework', 'core', 'src', 'python'),
    bindingDirectory,
    process.env.PYTHONPATH,
  ]
    .filter(Boolean)
    .join(path.delimiter);
  const testResult = spawnSync(
    'uv',
    [
      'run',
      '--project',
      path.join(ROOT, 'framework', 'core'),
      '--frozen',
      'pytest',
      '-q',
      TEST,
      '-k',
      'durable_admission or durable_fault_frontier',
    ],
    {
      cwd: ROOT,
      env: { ...process.env, PYTHONPATH: pythonPath },
      encoding: 'utf8',
    },
  );
  process.stdout.write(testResult.stdout || '');
  process.stderr.write(testResult.stderr || '');
  if (testResult.error || testResult.status !== 0)
    throw (
      testResult.error ||
      new Error(`qualification tests exited ${testResult.status}`)
    );

  const contract = JSON.parse(
    fs.readFileSync(path.join(ROOT, CONTRACT), 'utf8'),
  );
  const sourceFiles = SOURCE_PATHS.map(fileEvidence);
  const sourceSetRoot = digestDocument(sourceFiles);
  const underlyingPath =
    'docs/qualification/evidence/durability/production-candidate-v1/admission-report.json';
  const report = {
    schema: 'kungfu.fact.durable-admission-qualification-report/v1',
    status: 'qualified-current-hardware-candidate',
    profile: PROFILE,
    qualified_at: new Date().toISOString(),
    source: {
      base_sha: spawnSync('git', ['rev-parse', 'HEAD'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).stdout.trim(),
      files: sourceFiles,
      source_set_root: sourceSetRoot,
    },
    artifact: {
      path: path
        .relative(ROOT, path.join(repositoryBindingDirectory, binding))
        .split(path.sep)
        .join('/'),
      sha256: digestBytes(
        fs.readFileSync(path.join(bindingDirectory, binding)),
      ),
    },
    environment: {
      platform: os.platform(),
      architecture: os.arch(),
      host_envelope: requiredEnvironment(
        'KUNGFU_FACT_QUALIFICATION_HOST_ENVELOPE',
      ),
      filesystem: requiredEnvironment('KUNGFU_FACT_QUALIFICATION_FILESYSTEM'),
      device: requiredEnvironment('KUNGFU_FACT_QUALIFICATION_DEVICE'),
      kernel: requiredEnvironment('KUNGFU_FACT_QUALIFICATION_KERNEL'),
    },
    contract: {
      path: CONTRACT,
      sha256: sourceFiles.find((entry) => entry.path === CONTRACT).sha256,
      default_enabled: contract.durableAdmission.defaultEnabled,
      production_eligible: contract.durableAdmission.productionEligible,
    },
    underlying_durable_ingest: fileEvidence(underlyingPath),
    providers: contract.durableAdmission.providers,
    fault_campaign: {
      runner: TEST,
      fresh_reopen: true,
      result: 'passed',
      cases: contract.durableAdmission.qualificationFaults.map((id) => ({
        id,
        status: 'passed',
      })),
    },
    release_gate: contract.durableAdmission.releaseGate,
    checker: fileEvidence('scripts/check-fact-durable-admission.test.mjs'),
    residual_risks: [
      'Physical power loss on the composed Fact path is not qualified.',
      'Independent failure-domain restore is not qualified.',
      'The candidate is explicit and default-off; it is not production eligible.',
      'RocksDB wal-os-buffered remains rejected for durable_group and durable_sync.',
    ],
    non_claims: [
      'No physical host power cut was performed by this qualification.',
      'No replication, high availability, consensus, or production eligibility is claimed.',
      'Deterministic cut-point injection is not a substitute for device-loss evidence.',
    ],
  };
  report.report_root = digestDocument(report);
  const absoluteOutput = path.resolve(ROOT, output);
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[fact-durable-admission] retained ${output}`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `[fact-durable-admission] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
