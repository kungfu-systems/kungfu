// SPDX-License-Identifier: Apache-2.0
// @ts-check

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HARNESS_DIR, '..', '..', '..', '..', '..');
const PROFILE_SCHEMA_PATH = path.join(
  HARNESS_DIR,
  'schemas',
  'durability-qualification-profile-v1.schema.json',
);
const REPORT_SCHEMA_PATH = path.join(
  HARNESS_DIR,
  'schemas',
  'durability-qualification-report-v1.schema.json',
);

/** @type {Record<string, {args: string[], requiredMarkers: string[], profileMarkers?: Record<string, string[]>}>} */
const SUITES = {
  'durable-ingest': {
    args: ['test:durable-ingest'],
    requiredMarkers: [
      '[durable-ingest-test] cross-process writer attestation passed',
    ],
    profileMarkers: {
      durable_group: [
        'ok - group barrier survives verified restart',
        'ok - rollover preserves order and checkpoint',
      ],
      durable_sync: [
        'ok - data sync without checkpoint never acknowledges',
        'ok - unknown after checkpoint publish resolves on restart',
        'ok - injected sync I/O error has no false acknowledgement',
        'ok - checkpoint rename error has no false acknowledgement',
      ],
    },
  },
  'projection-bootstrap': {
    args: ['test:projection-bootstrap'],
    requiredMarkers: [
      '[projection-bootstrap-test] cross-process restart passed',
      '[projection-bootstrap-test] candidate snapshot/replay contracts passed',
    ],
  },
  'crash-recovery': {
    args: ['test:crash-recovery'],
    requiredMarkers: [
      '[crash-recovery-test] whole-data-root process restart passed',
      '[crash-recovery-test] recovery completion contracts passed',
    ],
  },
  'episode-mvp-smoke': {
    args: [
      'episode:qualify',
      '--',
      '--profile',
      'mvp-smoke-v1',
      '--mode',
      'all',
    ],
    requiredMarkers: [
      '[episode-qualify] semantic oracle and production comparisons',
      'scenarios=5 passed=5',
      'qualified=true',
    ],
  },
};

/** @type {Record<string, string[]>} */
const FAULT_EVIDENCE = {
  'append-outcome-unknown': ['durable-ingest'],
  'barrier-checkpoint-ordering': ['durable-ingest'],
  'torn-or-corrupt-tail': ['durable-ingest', 'crash-recovery'],
  'rollover-ordering': ['durable-ingest'],
  'storage-error-propagation': ['durable-ingest'],
  'ownership-fencing': ['durable-ingest', 'crash-recovery'],
  'projection-loss-rebuild': ['projection-bootstrap', 'crash-recovery'],
  'episode-capability-oracle': ['episode-mvp-smoke'],
  'whole-data-root-reopen': ['crash-recovery'],
  'verified-backup-restore': ['crash-recovery'],
  'service-restart-order': ['crash-recovery'],
};

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function json(pathname) {
  return JSON.parse(fs.readFileSync(pathname, 'utf8'));
}

function ajv() {
  return new Ajv2020({ allErrors: true, strict: false });
}

function schemaError(validate) {
  return (validate.errors || [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

export function loadProfile(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid profile name '${name}'`);
  }
  const pathname = path.join(HARNESS_DIR, 'profiles', `${name}.json`);
  if (!fs.existsSync(pathname)) throw new Error(`profile not found: ${name}`);
  const raw = fs.readFileSync(pathname, 'utf8');
  const profile = JSON.parse(raw);
  const validate = ajv().compile(json(PROFILE_SCHEMA_PATH));
  if (!validate(profile)) {
    throw new Error(`profile schema invalid: ${schemaError(validate)}`);
  }
  if (profile.name !== name) {
    throw new Error(`profile name '${profile.name}' does not match ${name}`);
  }
  for (const suite of profile.required_suites) {
    if (!(suite in SUITES))
      throw new Error(`unknown required suite '${suite}'`);
  }
  for (const fault of profile.required_faults) {
    if (!(fault in FAULT_EVIDENCE)) {
      throw new Error(`unknown required fault '${fault}'`);
    }
    const missing = FAULT_EVIDENCE[fault].filter(
      (suite) => !profile.required_suites.includes(suite),
    );
    if (missing.length > 0) {
      throw new Error(
        `fault '${fault}' is missing suites: ${missing.join(', ')}`,
      );
    }
  }
  return { profile, raw, digest: sha256(raw) };
}

export function qualificationPlan(profile, durabilityProfile) {
  if (!profile.durability_profiles.includes(durabilityProfile)) {
    throw new Error(
      `profile '${profile.name}' does not cover ${durabilityProfile}`,
    );
  }
  const launcher = process.platform === 'win32' ? 'shifu.cmd' : './shifu';
  return profile.required_suites.map((id) => ({
    id,
    command: [launcher, ...SUITES[id].args],
    required_markers: [
      ...SUITES[id].requiredMarkers,
      ...(SUITES[id].profileMarkers?.[durabilityProfile] || []),
    ],
  }));
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim();
}

export function sourceFacts() {
  const status = git(['status', '--porcelain']);
  return {
    revision: git(['rev-parse', 'HEAD']) || 'unknown',
    tree: git(['rev-parse', 'HEAD^{tree}']) || 'unknown',
    dirty: status === null || status !== '',
  };
}

function plannedSuite(step) {
  return {
    ...step,
    status: 'planned',
    exit_code: null,
    duration_ms: 0,
    missing_markers: [],
    raw_log: null,
    raw_sha256: null,
  };
}

function cmdQuote(value) {
  if (/^[A-Za-z0-9_./:\\-]+$/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

export function qualificationCommandInvocation(
  command,
  platform = process.platform,
  env = process.env,
) {
  if (platform !== 'win32' || !/\.cmd$/iu.test(command[0])) {
    return { command: command[0], args: command.slice(1) };
  }
  const executable = env.ComSpec || env.COMSPEC || 'cmd.exe';
  const line = command.map((item) => cmdQuote(String(item))).join(' ');
  return {
    command: executable,
    args: ['/d', '/s', '/c', `call ${line}`],
  };
}

function runCommand(command, env = process.env) {
  const started = Date.now();
  const invocation = qualificationCommandInvocation(
    command,
    process.platform,
    env,
  );
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    result,
    duration: Date.now() - started,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function executeSuite(step, rawDir) {
  console.log(`[durability-qualify] running ${step.id}`);
  const executed = runCommand(step.command, {
    ...process.env,
    KUNGFU_DURABILITY_QUALIFICATION: 'process-crash-proxy',
  });
  const missingMarkers = step.required_markers.filter(
    (marker) => !executed.output.includes(marker),
  );
  const rawName = `${step.id}.log`;
  const rawPath = path.join(rawDir, rawName);
  fs.writeFileSync(rawPath, executed.output, { flag: 'wx' });
  const passed =
    !executed.result.error &&
    executed.result.status === 0 &&
    missingMarkers.length === 0;
  console.log(
    `[durability-qualify] suite=${step.id} status=${passed ? 'passed' : 'failed'} duration_ms=${executed.duration}`,
  );
  return {
    ...step,
    status: passed ? 'passed' : 'failed',
    exit_code: executed.result.status,
    duration_ms: executed.duration,
    missing_markers: missingMarkers,
    raw_log: path.join('raw', rawName),
    raw_sha256: sha256(executed.output),
  };
}

function doctor(mode) {
  if (mode === 'dry-run') {
    return {
      node: process.version,
      doctor_status: 'planned',
      doctor_sha256: null,
      doctor: null,
    };
  }
  const launcher = process.platform === 'win32' ? 'shifu.cmd' : './shifu';
  const executed = runCommand([launcher, 'doctor', '--json']);
  let parsed = null;
  try {
    parsed = JSON.parse(executed.output.trim());
  } catch {
    parsed = null;
  }
  return {
    node: process.version,
    doctor_status: executed.result.status === 0 && parsed ? 'passed' : 'failed',
    doctor_sha256: sha256(executed.output),
    doctor: parsed,
  };
}

export function evaluateQualification({
  mode,
  loaded,
  durabilityProfile,
  filesystem,
  source,
  platform,
  toolchain,
  suites,
  runId,
}) {
  const violations = [];
  if (mode === 'execute') {
    if (source.dirty) violations.push('source worktree is dirty');
    if (platform.os !== loaded.profile.platform.node_platform) {
      violations.push(
        `platform ${platform.os} does not match ${loaded.profile.platform.node_platform}`,
      );
    }
    if (!loaded.profile.platform.architectures.includes(platform.arch)) {
      violations.push(
        `architecture ${platform.arch} is outside ${loaded.profile.platform.architectures.join(',')}`,
      );
    }
    if (!filesystem) {
      violations.push('filesystem declaration is required for execution');
    } else if (filesystem !== loaded.profile.platform.filesystem) {
      violations.push(
        `filesystem ${filesystem} does not match ${loaded.profile.platform.filesystem}`,
      );
    }
    if (toolchain.doctor_status !== 'passed') {
      violations.push(
        'Shifu doctor did not produce a passing JSON fact record',
      );
    }
    for (const suite of suites) {
      if (suite.status !== 'passed') {
        violations.push(`suite ${suite.id} did not pass`);
      }
    }
  }

  const faultCoverage = loaded.profile.required_faults.map((id) => {
    const evidenceSuites = FAULT_EVIDENCE[id];
    const status =
      mode === 'dry-run'
        ? 'planned'
        : evidenceSuites.every(
              (suite) =>
                suites.find((item) => item.id === suite)?.status === 'passed',
            )
          ? 'passed'
          : 'failed';
    return { id, evidence_suites: evidenceSuites, status };
  });
  const suiteFailure = suites.some((suite) => suite.status === 'failed');
  const verdict =
    mode === 'dry-run'
      ? 'planned'
      : violations.length === 0
        ? 'passed'
        : suiteFailure
          ? 'failed'
          : 'unqualified';
  const report = {
    schema: 'kungfu.durability.qualification-report/v1',
    run_id: runId,
    mode,
    source,
    profile: {
      name: loaded.profile.name,
      digest_sha256: loaded.digest,
      evidence_tier: loaded.profile.evidence_tier,
    },
    durability_profile: durabilityProfile,
    platform: {
      ...platform,
      filesystem: filesystem || 'unknown',
      filesystem_evidence: filesystem ? 'operator-declared' : 'not-collected',
    },
    toolchain,
    suites,
    fault_coverage: faultCoverage,
    claims: {
      declared_process_envelope_qualified: verdict === 'passed',
      power_loss_qualified: false,
      production_profile_eligible: false,
    },
    non_claims: loaded.profile.non_claims,
    violations,
    verdict,
  };
  const validate = ajv().compile(json(REPORT_SCHEMA_PATH));
  assert.equal(validate(report), true, schemaError(validate));
  return report;
}

function usage() {
  console.log(`Kungfu Durability Qualification Harness

Usage:
  ./shifu durability:qualify -- --profile NAME --durability-profile NAME [options]

The command is dry-run by default. Execution is explicit and writes immutable
raw logs next to the report.

Options:
  --profile NAME                platform/filesystem process profile
  --durability-profile NAME     durable_group or durable_sync
  --filesystem NAME             operator-declared filesystem for execution
  --report PATH                 report destination (must not already exist)
  --execute                     run the local Shifu qualification suites
  --json                        print the complete plan/report
  -h, --help                    show this help
`);
}

function parseArgs(argv) {
  const options = {
    profile: '',
    durabilityProfile: '',
    filesystem: '',
    report: '',
    execute: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--profile') options.profile = next();
    else if (arg === '--durability-profile') {
      options.durabilityProfile = next();
    } else if (arg === '--filesystem')
      options.filesystem = next().toLowerCase();
    else if (arg === '--report') options.report = path.resolve(next());
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else throw new Error(`unknown argument '${arg}'`);
  }
  if (!options.profile) throw new Error('--profile is required');
  if (!['durable_group', 'durable_sync'].includes(options.durabilityProfile)) {
    throw new Error(
      '--durability-profile must be durable_group or durable_sync',
    );
  }
  if (options.execute && !options.report) {
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
    options.report = path.join(
      os.tmpdir(),
      `kungfu-durability-${options.profile}-${options.durabilityProfile}-${stamp}.json`,
    );
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const loaded = loadProfile(options.profile);
  const plan = qualificationPlan(loaded.profile, options.durabilityProfile);
  const mode = options.execute ? 'execute' : 'dry-run';
  const runId = `${options.profile}-${options.durabilityProfile}-${new Date().toISOString()}`;
  const source = sourceFacts();
  const platform = {
    os: process.platform,
    arch: process.arch,
    release: os.release(),
  };
  const toolchain = doctor(mode);
  let suites = plan.map(plannedSuite);
  const preflightPassed =
    !source.dirty &&
    platform.os === loaded.profile.platform.node_platform &&
    loaded.profile.platform.architectures.includes(platform.arch) &&
    options.filesystem === loaded.profile.platform.filesystem &&
    toolchain.doctor_status === 'passed';
  if (options.execute && preflightPassed) {
    if (fs.existsSync(options.report)) {
      throw new Error(`report already exists: ${options.report}`);
    }
    const reportDir = path.dirname(options.report);
    const rawDir = path.join(
      reportDir,
      `${path.basename(options.report, '.json')}.raw`,
    );
    if (fs.existsSync(rawDir))
      throw new Error(`raw directory exists: ${rawDir}`);
    fs.mkdirSync(rawDir, { recursive: true });
    suites = plan.map((step) => executeSuite(step, rawDir));
    suites = suites.map((suite) => ({
      ...suite,
      raw_log: path.join(path.basename(rawDir), path.basename(suite.raw_log)),
    }));
  }
  const report = evaluateQualification({
    mode,
    loaded,
    durabilityProfile: options.durabilityProfile,
    filesystem: options.filesystem,
    source,
    platform,
    toolchain,
    suites,
    runId,
  });
  if (options.report) {
    if (fs.existsSync(options.report)) {
      throw new Error(`report already exists: ${options.report}`);
    }
    fs.mkdirSync(path.dirname(options.report), { recursive: true });
    fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, {
      flag: 'wx',
    });
    console.log(`[durability-qualify] report=${options.report}`);
  }
  console.log(
    `[durability-qualify] mode=${mode} profile=${options.profile} durability=${options.durabilityProfile} verdict=${report.verdict}`,
  );
  console.log(
    '[durability-qualify] power_loss_qualified=false production_profile_eligible=false',
  );
  if (!options.execute || options.json) {
    console.log(JSON.stringify(report, null, 2));
  }
  if (options.execute && report.verdict !== 'passed') process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(
      `[durability-qualify] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
