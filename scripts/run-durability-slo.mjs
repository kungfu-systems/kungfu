#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_ROOT = path.join(
  ROOT,
  'framework/core/tests/qualification/durability/profiles',
);
const WORKSPACE_ROOT = path.join(
  ROOT,
  'framework/core/build/qualification/durability-slo',
);
const BINARY = path.join(
  ROOT,
  'framework/core/build/Release/kungfu_durability_slo_fixture',
);
const CONFIRMATION = 'agent120-slo-v1';

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function command(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    timeout: options.timeout,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${argv.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`,
    );
  }
  return result.stdout.trim();
}

function parseOptions(argv) {
  const result = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') {
      result.execute = true;
      continue;
    }
    if (!argument.startsWith('--') || index + 1 >= argv.length) {
      throw new Error(`invalid option: ${argument}`);
    }
    result[argument.slice(2)] = argv[index + 1];
    index += 1;
  }
  return result;
}

function requireBelow(candidate, root, label) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(path.resolve(root), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} must be a new path below ${root}`);
  }
  return resolved;
}

function validateProfile(profile) {
  if (
    profile.schema !== 'kungfu.durability.slo-profile/v1' ||
    profile.id !== 'linux-ext4-agent120-slo-v1' ||
    profile.host !== 'agent-120' ||
    profile.platform !== 'linux' ||
    profile.arch !== 'x64' ||
    profile.filesystem !== 'ext4' ||
    profile.device_class !== 'nvme' ||
    profile.qualification_profile !== 'candidate/linux-ext4-agent120-slo-v1'
  ) {
    throw new Error('invalid or unsupported durability SLO profile identity');
  }
  if (!Array.isArray(profile.workloads) || profile.workloads.length < 8) {
    throw new Error('durability SLO profile must contain all eight workloads');
  }
  const ids = new Set();
  for (const workload of profile.workloads) {
    if (ids.has(workload.id))
      throw new Error(`duplicate workload ${workload.id}`);
    ids.add(workload.id);
    if (
      !['durable_group', 'durable_sync'].includes(workload.durability_profile)
    ) {
      throw new Error(`invalid durability profile for ${workload.id}`);
    }
    if ((workload.records === 0) === (workload.duration_seconds === 0)) {
      throw new Error(
        `workload ${workload.id} needs exactly one stopping rule`,
      );
    }
    for (const threshold of [
      'append_p999_ns_max',
      'receipt_p999_ns_max',
      'records_per_second_min',
    ]) {
      if (!(workload.thresholds[threshold] > 0)) {
        throw new Error(`missing positive ${threshold} for ${workload.id}`);
      }
    }
  }
}

export function loadSloProfile(name = 'linux-ext4-agent120-slo-v1') {
  if (!/^[a-z0-9-]+$/u.test(name)) throw new Error('invalid profile name');
  const pathname = path.join(PROFILE_ROOT, `${name}.json`);
  const bytes = fs.readFileSync(pathname);
  const profile = JSON.parse(bytes);
  validateProfile(profile);
  return { profile, pathname, digest: sha256Bytes(bytes) };
}

export function workloadCommand(binary, root, workload) {
  return [
    binary,
    'run',
    root,
    workload.durability_profile,
    String(workload.records),
    String(workload.payload_bytes),
    String(workload.batch_size),
    String(workload.segment_bytes),
    String(workload.duration_seconds),
    String(workload.target_rate),
  ];
}

export function qualificationPlan({ loaded, runId, sourceRevision }) {
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/u.test(runId)) {
    throw new Error('run id must be a safe 3-64 character component');
  }
  const workspace = path.join(WORKSPACE_ROOT, runId);
  return {
    schema: 'kungfu.durability.slo-execution-plan/v1',
    mode: 'dry-run',
    profile: {
      id: loaded.profile.id,
      sha256: loaded.digest,
      thresholds_frozen_before_measurement: true,
    },
    source_revision: sourceRevision,
    workspace,
    report: path.join(workspace, 'evidence', 'durability-slo-report.json'),
    raw_results: path.join(
      workspace,
      'evidence',
      'durability-slo-results.jsonl',
    ),
    safety: {
      creates_only_below: workspace,
      cleanup: 'not performed; workspace and evidence remain for review',
      github_workflow: false,
      self_hosted_runner_dispatch: false,
      host_restart: false,
      physical_device_write: false,
      production_activation: false,
    },
    workloads: loaded.profile.workloads.map((workload) => ({
      id: workload.id,
      command: workloadCommand(
        BINARY,
        path.join(workspace, 'runs', workload.id),
        workload,
      ),
      thresholds: workload.thresholds,
    })),
  };
}

function compareMaximum(violations, label, observed, maximum) {
  if (!(Number.isFinite(observed) && observed <= maximum)) {
    violations.push(`${label}=${observed} exceeds ${maximum}`);
  }
}

function compareMinimum(violations, label, observed, minimum) {
  if (!(Number.isFinite(observed) && observed >= minimum)) {
    violations.push(`${label}=${observed} below ${minimum}`);
  }
}

export function evaluateWorkload(workload, fixture, globalThresholds) {
  const violations = [];
  if (fixture.schema !== 'kungfu.durability.slo-fixture-result/v1') {
    violations.push('fixture schema mismatch');
    return violations;
  }
  if (!fixture.correctness?.passed || fixture.correctness.violations.length) {
    violations.push('correctness knockout');
  }
  if (
    fixture.qualification_profile !== 'candidate/linux-ext4-agent120-slo-v1'
  ) {
    violations.push('qualification profile mismatch');
  }
  if (fixture.profile !== workload.durability_profile) {
    violations.push('durability profile mismatch');
  }
  const completed = fixture.workload?.records_completed;
  if (workload.records > 0 && completed !== workload.records) {
    violations.push(
      `records_completed=${completed} expected ${workload.records}`,
    );
  }
  if (workload.duration_seconds > 0 && !(completed > 0)) {
    violations.push('soak completed no records');
  }
  for (const histogram of [
    'candidate_append_latency',
    'durability_receipt_latency',
  ]) {
    if (fixture.metrics?.[histogram]?.count !== completed) {
      violations.push(`${histogram} count mismatch`);
    }
    if (!fixture.metrics?.[histogram]?.buckets?.length) {
      violations.push(`${histogram} buckets missing`);
    }
  }
  compareMaximum(
    violations,
    'append_p999_ns',
    fixture.metrics?.candidate_append_latency?.p999_ns,
    workload.thresholds.append_p999_ns_max,
  );
  compareMaximum(
    violations,
    'receipt_p999_ns',
    fixture.metrics?.durability_receipt_latency?.p999_ns,
    workload.thresholds.receipt_p999_ns_max,
  );
  compareMinimum(
    violations,
    'records_per_second',
    fixture.metrics?.records_per_second,
    workload.thresholds.records_per_second_min,
  );
  for (const [metric, threshold] of Object.entries(globalThresholds)) {
    const metricName = metric.replace(/_max$/u, '');
    const observed =
      metricName === 'max_rss_kib'
        ? fixture.metrics?.resources?.max_rss_kib
        : fixture.metrics?.[metricName];
    compareMaximum(violations, metricName, observed, threshold);
  }
  if (fixture.claims?.production_eligible !== false) {
    violations.push('fixture widened production eligibility');
  }
  return violations;
}

export function evaluateReport({ loaded, plan, host, results, rawSha256 }) {
  const violations = [];
  if (host.hostname !== loaded.profile.host) {
    violations.push(
      `hostname=${host.hostname} expected ${loaded.profile.host}`,
    );
  }
  if (host.filesystem !== loaded.profile.filesystem) {
    violations.push(
      `filesystem=${host.filesystem} expected ${loaded.profile.filesystem}`,
    );
  }
  if (!host.device_source.includes('nvme')) {
    violations.push(`device_source=${host.device_source} is not named NVMe`);
  }
  if (results.length !== loaded.profile.workloads.length) {
    violations.push(
      `completed_workloads=${results.length} expected ${loaded.profile.workloads.length}`,
    );
  }
  for (const result of results) violations.push(...result.violations);
  return {
    schema: 'kungfu.durability.slo-report/v1',
    run_id: path.basename(plan.workspace),
    generated_at: new Date().toISOString(),
    verdict: violations.length ? 'rejected' : 'passed-candidate-slo',
    source_revision: plan.source_revision,
    profile: plan.profile,
    host,
    raw_results: path.relative(plan.workspace, plan.raw_results),
    raw_results_sha256: rawSha256,
    results,
    violations,
    claims: loaded.profile.claims,
  };
}

function collectHostFacts() {
  const mount = command([
    'findmnt',
    '-n',
    '-o',
    'FSTYPE,SOURCE,OPTIONS',
    '--target',
    ROOT,
  ]).split(/\s+/u);
  return {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
    cpu_model: os.cpus()[0]?.model || 'unknown',
    cpu_count: os.cpus().length,
    total_memory_bytes: os.totalmem(),
    filesystem: mount[0] || 'unknown',
    device_source: mount[1] || 'unknown',
    mount_options: mount.slice(2).join(' '),
    uname: command(['uname', '-a']),
  };
}

function writeJsonExclusive(pathname, value) {
  const descriptor = fs.openSync(pathname, 'wx');
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function appendRaw(descriptor, value) {
  fs.writeSync(descriptor, `${JSON.stringify(value)}\n`);
  fs.fsyncSync(descriptor);
}

function execute({ loaded, plan }) {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('durability SLO execution requires Linux x64');
  }
  if (process.env.KUNGFU_DURABILITY_SLO_CONFIRMATION !== CONFIRMATION) {
    throw new Error(
      `KUNGFU_DURABILITY_SLO_CONFIRMATION=${CONFIRMATION} is required`,
    );
  }
  if (fs.realpathSync(process.cwd()) !== fs.realpathSync(ROOT)) {
    throw new Error('execute must run from the exact source worktree');
  }
  if (command(['git', 'status', '--porcelain'])) {
    throw new Error('source worktree must be clean');
  }
  if (command(['git', 'rev-parse', 'HEAD']) !== plan.source_revision) {
    throw new Error('source revision changed after planning');
  }
  if (!fs.existsSync(BINARY)) {
    throw new Error('SLO fixture is absent; run ./shifu build:core first');
  }
  if (fs.existsSync(plan.workspace)) {
    throw new Error(`refusing existing workspace: ${plan.workspace}`);
  }
  requireBelow(plan.workspace, WORKSPACE_ROOT, 'workspace');
  requireBelow(plan.report, plan.workspace, 'report');
  requireBelow(plan.raw_results, plan.workspace, 'raw results');
  fs.mkdirSync(path.join(plan.workspace, 'evidence'), { recursive: true });
  fs.mkdirSync(path.join(plan.workspace, 'runs'), { recursive: true });
  const rawDescriptor = fs.openSync(plan.raw_results, 'wx');
  const results = [];
  try {
    for (const workload of loaded.profile.workloads) {
      const runRoot = path.join(plan.workspace, 'runs', workload.id);
      const argv = workloadCommand(BINARY, runRoot, workload);
      const timeout = (workload.duration_seconds + 120) * 1000;
      const startedAt = new Date().toISOString();
      const execution = spawnSync(argv[0], argv.slice(1), {
        cwd: ROOT,
        encoding: 'utf8',
        timeout,
      });
      let fixture = null;
      const executionViolations = [];
      if (execution.error || execution.status !== 0) {
        executionViolations.push(
          `execution failed: ${execution.error?.message || execution.stderr || execution.status}`,
        );
      } else {
        try {
          fixture = JSON.parse(execution.stdout);
        } catch (error) {
          executionViolations.push(`invalid fixture JSON: ${error.message}`);
        }
      }
      const violations = fixture
        ? evaluateWorkload(workload, fixture, loaded.profile.global_thresholds)
        : executionViolations;
      const result = {
        id: workload.id,
        started_at: startedAt,
        command: argv,
        status: violations.length ? 'failed' : 'passed',
        fixture,
        stderr: execution.stderr?.trim() || '',
        violations,
      };
      appendRaw(rawDescriptor, result);
      results.push(result);
      if (
        violations.some((value) =>
          /correctness|execution|invalid fixture/u.test(value),
        )
      ) {
        break;
      }
    }
  } finally {
    fs.closeSync(rawDescriptor);
  }
  const rawSha256 = sha256Bytes(fs.readFileSync(plan.raw_results));
  const report = evaluateReport({
    loaded,
    plan,
    host: collectHostFacts(),
    results,
    rawSha256,
  });
  writeJsonExclusive(plan.report, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== 'passed-candidate-slo') process.exitCode = 1;
}

async function main() {
  const parsed = parseOptions(
    process.argv.slice(2).filter((argument) => argument !== '--'),
  );
  const loaded = loadSloProfile(parsed.profile);
  const sourceRevision = command(['git', 'rev-parse', 'HEAD']);
  const plan = qualificationPlan({
    loaded,
    runId: parsed['run-id'],
    sourceRevision,
  });
  if (!parsed.execute) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  execute({ loaded, plan });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[durability-slo] ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
    process.exit(1);
  }
}
