// SPDX-License-Identifier: Apache-2.0
//
// Bind a full Episode Trust Report to the exact source, profile, toolchain,
// runtime artifacts, and platform that produced it. The qualification harness
// remains the semantic authority; this file only runs, seals, and verifies its
// release-readiness evidence.
// @ts-check

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const harnessDir = path.dirname(scriptPath);
const coreDir = path.resolve(harnessDir, '..', '..', '..');
const rootDir = path.resolve(coreDir, '..', '..');
const runnerPath = path.join(harnessDir, 'run.mjs');
const workerPath = path.join(harnessDir, 'episode_workload.py');
const trustSchemaPath = path.join(
  harnessDir,
  'schemas',
  'trust-report-v2.schema.json',
);
const evidenceSchemaPath = path.join(
  harnessDir,
  'schemas',
  'release-evidence-v1.schema.json',
);
const runtimeRoot = path.join(coreDir, 'dist', 'kungfu');
const DEFAULT_RELEASE_PROFILE = 'mvp-baseline-v1';
const CORRECTNESS_FIELDS = [
  'count_mismatches',
  'readback_mismatches',
  'fsck_failures',
  'recovery_mismatches',
  'retry_exhausted',
  'unexpected_errors',
  'progress_timeouts',
];

function fail(message) {
  console.error(`episode release evidence: ${message}`);
  process.exit(2);
}

function usage() {
  console.log(`Episode Qualification Release Evidence v1

Usage:
  ./shifu episode:qualify:release -- [--profile NAME] [--output PATH] [--keep-runtime]
  ./shifu episode:qualify:release -- verify --evidence PATH [--check-runtime] [--json]

The run command defaults to the complete mvp-baseline-v1 profile. A checked-in
bounded profile can be selected explicitly for a budgeted qualification run.
It writes one self-contained release-evidence envelope that embeds Trust Report v2.
Performance observations are trend evidence; no absolute throughput SLO is
implied by this command.`);
}

function parseArgs(argv) {
  const values = [...argv].filter((arg) => arg !== '--');
  let command = 'run';
  if (values[0] === 'verify') {
    command = 'verify';
    values.shift();
  }
  const options = {
    command,
    output: path.join(
      rootDir,
      'product',
      'release',
      'qualification',
      'episode-release-evidence.json',
    ),
    evidence: '',
    keepRuntime: false,
    checkRuntime: false,
    json: false,
    profile: DEFAULT_RELEASE_PROFILE,
  };
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    const next = () => {
      index += 1;
      if (index >= values.length) fail(`${arg} requires a value`);
      return values[index];
    };
    if (arg === '--output') options.output = path.resolve(next());
    else if (arg === '--profile') options.profile = next();
    else if (arg === '--evidence') options.evidence = path.resolve(next());
    else if (arg === '--keep-runtime') options.keepRuntime = true;
    else if (arg === '--check-runtime') options.checkRuntime = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else fail(`unknown argument '${arg}'`);
  }
  if (command === 'verify' && !options.evidence) {
    fail('verify requires --evidence PATH');
  }
  return options;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

export function canonicalDigest(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function fileDigest(filePath) {
  return `sha256:${createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readTrimmed(filePath) {
  return fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8').trim()
    : '';
}

function isSafeRepoRelative(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    !value.split(/[\\/]/).includes('..')
  );
}

function gitText(args) {
  const child = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (child.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(child.stderr || '').trim()}`,
    );
  }
  return child.stdout.trim();
}

function toolVersion(program, args) {
  const child = spawnSync(program, args, {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (child.status !== 0) return 'unavailable';
  return `${child.stdout || ''}${child.stderr || ''}`.trim().split('\n')[0];
}

function profileRecord(name = RELEASE_PROFILE) {
  const profilePath = path.join(harnessDir, 'profiles', `${name}.json`);
  if (!fs.existsSync(profilePath))
    throw new Error(`profile not found: ${profilePath}`);
  const document = readJson(profilePath);
  return {
    name,
    schema: document.schema,
    path: path.relative(rootDir, profilePath).split(path.sep).join('/'),
    canonical_json_sha256: canonicalDigest(document),
    document,
  };
}

function shouldFingerprint(relativePath) {
  const basename = path.basename(relativePath).toLowerCase();
  return (
    basename === 'kungfu' ||
    basename === 'kungfu.exe' ||
    basename === 'kungfubuildinfo.json' ||
    /\.(?:so(?:\..*)?|dylib|dll|pyd|node|exe)$/i.test(basename)
  );
}

export function collectRuntimeArtifacts(root = runtimeRoot) {
  const artifacts = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        const relative = path
          .relative(rootDir, absolute)
          .split(path.sep)
          .join('/');
        if (!shouldFingerprint(relative)) continue;
        const stat = fs.statSync(absolute);
        artifacts.push({
          path: relative,
          bytes: stat.size,
          sha256: fileDigest(absolute),
        });
      }
    }
  };
  visit(root);
  artifacts.sort((left, right) => left.path.localeCompare(right.path));
  return artifacts;
}

function runtimeManifest(artifacts) {
  return {
    root: path.relative(rootDir, runtimeRoot).split(path.sep).join('/'),
    file_count: artifacts.length,
    total_bytes: artifacts.reduce(
      (total, artifact) => total + artifact.bytes,
      0,
    ),
    canonical_manifest_sha256: canonicalDigest(artifacts),
    artifacts,
  };
}

function toolchainRecord() {
  const rootPackage = readJson(path.join(rootDir, 'package.json'));
  const lerna = readJson(path.join(rootDir, 'lerna.json'));
  const buildchainPackage = readJson(
    path.join(
      rootDir,
      'node_modules',
      '@kungfu-tech',
      'buildchain',
      'package.json',
    ),
  );
  return {
    shifu: {
      version: lerna.version,
      entrypoint_provenance: process.env.SHIFU_ENTRYPOINT === '1',
    },
    node: process.version,
    python: toolVersion('uv', ['run', '--frozen', 'python', '--version']),
    uv: toolVersion('uv', ['--version']),
    package_manager: rootPackage.packageManager,
    buildchain_package: `${buildchainPackage.name}@${buildchainPackage.version}`,
    pins: {
      node: readTrimmed(path.join(rootDir, '.node-version')),
      fnm: readTrimmed(path.join(rootDir, '.fnm-version')),
      uv: readTrimmed(path.join(rootDir, '.uv-version')),
    },
  };
}

function ciRecord(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true') return { provider: 'local' };
  const server = env.GITHUB_SERVER_URL || 'https://github.com';
  return {
    provider: 'github-actions',
    repository: env.GITHUB_REPOSITORY || '',
    workflow: env.GITHUB_WORKFLOW || '',
    job: env.GITHUB_JOB || '',
    run_id: env.GITHUB_RUN_ID || '',
    run_attempt: env.GITHUB_RUN_ATTEMPT || '',
    ref: env.GITHUB_REF || '',
    sha: env.GITHUB_SHA || '',
    source_sha: env.BUILDCHAIN_SOURCE_SHA || '',
    buildchain_runtime_ref: env.BUILDCHAIN_RUNTIME_REF || '',
    buildchain_runtime_sha: env.BUILDCHAIN_RUNTIME_SHA || '',
    run_url:
      env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
        ? `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
        : '',
  };
}

function gate(id, passed, evidence) {
  return { id, passed: Boolean(passed), evidence: String(evidence) };
}

function expectedScenarioCount(profile) {
  return (
    profile.document.seeds.length *
    (profile.document.accumulation.checkpoints.length +
      profile.document.contention.workers.length)
  );
}

export function evaluateHardGates(report, context) {
  const correctness = report.correctness || {};
  const requiredDimensions =
    report.semantic_evidence?.required_dimensions || [];
  const dimensions = report.semantic_evidence?.dimensions || {};
  const scenarios = report.workload?.scenarios || [];
  const expectedScenarios = expectedScenarioCount(context.profile);
  const requiredDimensionsPassed =
    requiredDimensions.length > 0 &&
    requiredDimensions.every(
      (name) =>
        dimensions[name]?.status === 'passed' &&
        Number(dimensions[name]?.cases_executed || 0) > 0,
    );
  const correctnessZero = CORRECTNESS_FIELDS.every(
    (name) => Number.isInteger(correctness[name]) && correctness[name] === 0,
  );
  const faultCoverage = report.fault_coverage || {};
  const requiredFaultCoverage = [
    'writer_contention_exercised',
    'fresh_process_readback',
    'clean_recovery',
    'interrupted_open_recovery',
    'missing_content_and_hash_rejection',
    'dependency_failure_containment',
    'projection_drift_and_rebuild',
  ];
  return [
    gate(
      'harness_exit',
      context.harnessExit === 0,
      `exit=${context.harnessExit}`,
    ),
    gate(
      'shifu_entrypoint',
      context.shifuEntrypoint === true,
      `SHIFU_ENTRYPOINT=${context.shifuEntrypoint ? '1' : '0'}`,
    ),
    gate(
      'selected_profile',
      typeof context.profile.name === 'string' &&
        context.profile.name.length > 0,
      `profile=${context.profile.name}`,
    ),
    gate(
      'profile_consistency',
      report.profile === context.profile.name &&
        report.workload?.profile === context.profile.name,
      `report=${report.profile || ''} workload=${report.workload?.profile || ''}`,
    ),
    gate(
      'source_clean',
      report.source_dirty === false,
      `source_dirty=${String(report.source_dirty)}`,
    ),
    gate(
      'source_revision',
      report.source_revision === context.sourceRevision,
      `report=${report.source_revision || ''} expected=${context.sourceRevision}`,
    ),
    gate(
      'ci_source_revision',
      !context.ci?.source_sha ||
        context.ci.source_sha === context.sourceRevision,
      `ci=${context.ci?.source_sha || 'local'} expected=${context.sourceRevision}`,
    ),
    gate(
      'trust_report_qualified',
      report.qualified === true,
      `qualified=${String(report.qualified)}`,
    ),
    gate(
      'scenario_completeness',
      scenarios.length === expectedScenarios &&
        scenarios.every((scenario) => scenario.ok === true),
      `passed=${scenarios.filter((scenario) => scenario.ok === true).length}/${expectedScenarios}`,
    ),
    gate('correctness_zero', correctnessZero, canonicalJson(correctness)),
    gate(
      'fault_coverage',
      requiredFaultCoverage.every((name) => faultCoverage[name] === true),
      requiredFaultCoverage
        .map((name) => `${name}=${String(faultCoverage[name])}`)
        .join(' '),
    ),
    gate(
      'semantic_dimensions',
      requiredDimensionsPassed,
      requiredDimensions
        .map(
          (name) =>
            `${name}=${dimensions[name]?.status || 'missing'}/${dimensions[name]?.cases_executed || 0}`,
        )
        .join(' '),
    ),
    gate(
      'semantic_oracle',
      report.semantic_evidence?.oracle_check?.status === 'passed' &&
        Number(report.semantic_evidence?.oracle_check?.histories_checked || 0) >
          0,
      `status=${report.semantic_evidence?.oracle_check?.status || 'missing'} histories=${report.semantic_evidence?.oracle_check?.histories_checked || 0}`,
    ),
    gate(
      'runtime_artifacts',
      context.runtimeArtifacts.length > 0,
      `files=${context.runtimeArtifacts.length}`,
    ),
  ];
}

function withoutDigest(evidence) {
  return Object.fromEntries(
    Object.entries(structuredClone(evidence)).filter(
      ([key]) => key !== 'evidence_digest',
    ),
  );
}

export function sealEvidence(evidence) {
  const sealed = withoutDigest(evidence);
  sealed.evidence_digest = canonicalDigest(sealed);
  return sealed;
}

export function buildReleaseEvidence(report, context) {
  const hardGates = evaluateHardGates(report, context);
  const allPassed = hardGates.every((row) => row.passed);
  const artifacts = runtimeManifest(context.runtimeArtifacts);
  const evidence = {
    schema: 'kungfu.episode.release-evidence/v1',
    generated_at: context.completedAt,
    verdict: allPassed ? 'qualified' : 'failed',
    source: {
      repository: 'kungfu-systems/kungfu',
      revision: context.sourceRevision,
      tree: context.sourceTree,
      dirty: report.source_dirty,
    },
    invocation: {
      entrypoint: './shifu',
      task: 'episode:qualify:release',
      harness_task: 'episode:qualify',
      profile: context.profile.name,
      mode: 'all',
      started_at: context.startedAt,
      completed_at: context.completedAt,
      duration_seconds: context.durationSeconds,
      harness_exit: context.harnessExit,
    },
    profile: structuredClone(context.profile),
    platform: {
      runtime: report.platform,
      hardware: report.hardware,
    },
    toolchain: context.toolchain,
    runtime: {
      episode_contract: report.episode_contract,
      manifest_authority: report.backend_capabilities?.manifest_authority || '',
      artifact_manifest: artifacts,
    },
    ci: context.ci,
    qualification: {
      trust_report_schema: report.schema,
      trust_report_canonical_sha256: canonicalDigest(report),
      performance_policy: {
        mode: 'trend-only',
        absolute_slo: false,
        statement:
          'Throughput, latency, disk, RSS, and descriptor observations are evidence for comparison; v1 adopts no public absolute performance SLO.',
      },
      hard_gates: hardGates,
      gaps: report.gaps,
    },
    trust_report: structuredClone(report),
  };
  return sealEvidence(evidence);
}

export function validateReleaseEvidence(evidence, options = {}) {
  const errors = [];
  const push = (condition, message) => {
    if (!condition) errors.push(message);
  };
  push(
    evidence.schema === 'kungfu.episode.release-evidence/v1',
    'unsupported evidence schema',
  );
  push(
    evidence.evidence_digest === canonicalDigest(withoutDigest(evidence)),
    'evidence digest mismatch',
  );
  push(
    evidence.qualification?.trust_report_canonical_sha256 ===
      canonicalDigest(evidence.trust_report),
    'embedded Trust Report digest mismatch',
  );
  push(
    evidence.profile?.canonical_json_sha256 ===
      canonicalDigest(evidence.profile?.document),
    'embedded profile digest mismatch',
  );
  const profileRelativePath = evidence.profile?.path || '';
  push(
    isSafeRepoRelative(profileRelativePath),
    'profile path must be repository-relative',
  );
  push(
    evidence.runtime?.artifact_manifest?.canonical_manifest_sha256 ===
      canonicalDigest(evidence.runtime?.artifact_manifest?.artifacts || []),
    'runtime artifact manifest digest mismatch',
  );
  push(
    evidence.source?.revision === evidence.trust_report?.source_revision,
    'source revision differs from embedded Trust Report',
  );
  push(
    evidence.source?.dirty === evidence.trust_report?.source_dirty,
    'source dirty state differs from embedded Trust Report',
  );
  const context = {
    harnessExit: evidence.invocation?.harness_exit,
    shifuEntrypoint: evidence.toolchain?.shifu?.entrypoint_provenance,
    profile: evidence.profile,
    sourceRevision: evidence.source?.revision,
    runtimeArtifacts: evidence.runtime?.artifact_manifest?.artifacts || [],
    ci: evidence.ci || { provider: 'local' },
  };
  const expectedGates = evaluateHardGates(evidence.trust_report || {}, context);
  push(
    canonicalJson(evidence.qualification?.hard_gates || []) ===
      canonicalJson(expectedGates),
    'hard-gate rows do not match the embedded evidence',
  );
  const allPassed = expectedGates.every((row) => row.passed);
  push(
    evidence.verdict === (allPassed ? 'qualified' : 'failed'),
    'verdict does not match hard-gate results',
  );
  push(evidence.verdict === 'qualified', 'release evidence is not qualified');
  if (options.profilePath) {
    const currentProfile = readJson(options.profilePath);
    push(
      canonicalDigest(currentProfile) ===
        evidence.profile?.canonical_json_sha256,
      'current canonical profile differs from the embedded profile',
    );
  }
  if (options.runtimeArtifacts) {
    push(
      canonicalDigest(options.runtimeArtifacts) ===
        evidence.runtime?.artifact_manifest?.canonical_manifest_sha256,
      'current runtime artifacts differ from the evidence manifest',
    );
  }
  return { ok: errors.length === 0, errors };
}

function writeJsonAtomic(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

function validateJsonFile(dataPath, schemaPath) {
  const child = spawnSync(
    'uv',
    [
      'run',
      '--frozen',
      'python',
      workerPath,
      'validate-report',
      '--report',
      dataPath,
      '--schema',
      schemaPath,
    ],
    { cwd: coreDir, encoding: 'utf8' },
  );
  return {
    ok: child.status === 0,
    output: `${child.stdout || ''}${child.stderr || ''}`.trim().slice(-4000),
  };
}

function validateEmbeddedTrustReport(evidence) {
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kf-episode-evidence-verify-'),
  );
  try {
    const reportPath = path.join(temporaryRoot, 'trust-report.json');
    writeJsonAtomic(reportPath, evidence.trust_report);
    return validateJsonFile(reportPath, trustSchemaPath);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function runHarness(reportPath, keepRuntime, profileName) {
  const args = [
    runnerPath,
    '--profile',
    profileName,
    '--mode',
    'all',
    '--report',
    reportPath,
  ];
  if (keepRuntime) args.push('--keep-runtime');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', (error) => {
      console.error(
        `[episode-release-evidence] harness start failed: ${error.message}`,
      );
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function runCommand(options) {
  if (process.env.SHIFU_ENTRYPOINT !== '1') {
    fail('run through ./shifu episode:qualify:release');
  }
  const profile = profileRecord(options.profile);
  const sourceRevision = gitText(['rev-parse', 'HEAD']);
  const sourceTree = gitText(['rev-parse', 'HEAD^{tree}']);
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kf-episode-release-evidence-'),
  );
  const reportPath = path.join(temporaryRoot, 'episode-trust-report.json');
  try {
    console.log(
      `[episode-release-evidence] profile=${profile.name} output=${options.output}`,
    );
    const harnessExit = await runHarness(
      reportPath,
      options.keepRuntime,
      profile.name,
    );
    if (!fs.existsSync(reportPath)) {
      throw new Error(
        `qualification harness produced no Trust Report (exit ${harnessExit})`,
      );
    }
    const reportValidation = validateJsonFile(reportPath, trustSchemaPath);
    if (!reportValidation.ok) {
      throw new Error(
        `Trust Report schema invalid: ${reportValidation.output}`,
      );
    }
    const report = readJson(reportPath);
    const completedAt = new Date().toISOString();
    const artifacts = collectRuntimeArtifacts();
    const evidence = buildReleaseEvidence(report, {
      profile,
      sourceRevision,
      sourceTree,
      startedAt,
      completedAt,
      durationSeconds: (Date.now() - started) / 1000,
      harnessExit,
      shifuEntrypoint: process.env.SHIFU_ENTRYPOINT === '1',
      runtimeArtifacts: artifacts,
      toolchain: toolchainRecord(),
      ci: ciRecord(),
    });
    writeJsonAtomic(options.output, evidence);
    const schemaValidation = validateJsonFile(
      options.output,
      evidenceSchemaPath,
    );
    const internalValidation = validateReleaseEvidence(evidence, {
      profilePath: path.join(rootDir, profile.path),
      runtimeArtifacts: artifacts,
    });
    console.log(`[episode-release-evidence] evidence=${options.output}`);
    console.log(
      `[episode-release-evidence] verdict=${evidence.verdict} gates=${evidence.qualification.hard_gates.filter((row) => row.passed).length}/${evidence.qualification.hard_gates.length} digest=${evidence.evidence_digest}`,
    );
    if (!schemaValidation.ok) {
      console.error(
        `[episode-release-evidence] schema invalid: ${schemaValidation.output}`,
      );
    }
    if (!internalValidation.ok) {
      console.error(
        `[episode-release-evidence] validation failed: ${internalValidation.errors.join('; ')}`,
      );
    }
    process.exitCode =
      evidence.verdict === 'qualified' &&
      schemaValidation.ok &&
      internalValidation.ok
        ? 0
        : 1;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function verifyCommand(options) {
  const evidence = readJson(options.evidence);
  const evidenceSchema = validateJsonFile(options.evidence, evidenceSchemaPath);
  const trustSchema = validateEmbeddedTrustReport(evidence);
  const profileRelativePath = evidence.profile?.path || '';
  const profilePath = isSafeRepoRelative(profileRelativePath)
    ? path.join(rootDir, profileRelativePath)
    : undefined;
  const runtimeArtifacts = options.checkRuntime
    ? collectRuntimeArtifacts()
    : undefined;
  const internal = validateReleaseEvidence(evidence, {
    profilePath,
    runtimeArtifacts,
  });
  const result = {
    schema: 'kungfu.episode.release-evidence-verification/v1',
    ok: evidenceSchema.ok && trustSchema.ok && internal.ok,
    verdict: evidence.verdict,
    evidence: options.evidence,
    evidence_digest: evidence.evidence_digest,
    checks: {
      release_schema: evidenceSchema.ok,
      trust_report_schema: trustSchema.ok,
      internal_contract: internal.ok,
      current_runtime: options.checkRuntime,
    },
    errors: [
      ...(evidenceSchema.ok
        ? []
        : [`release schema: ${evidenceSchema.output}`]),
      ...(trustSchema.ok ? [] : [`Trust Report schema: ${trustSchema.output}`]),
      ...internal.errors,
    ],
  };
  if (options.json)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    console.log(
      `[episode-release-evidence] verify=${result.ok ? 'passed' : 'failed'} verdict=${result.verdict} digest=${result.evidence_digest}`,
    );
    for (const error of result.errors) console.error(`  - ${error}`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'verify') verifyCommand(options);
  else await runCommand(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  await main();
}
