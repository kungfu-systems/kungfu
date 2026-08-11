// SPDX-License-Identifier: Apache-2.0
// @ts-check

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
const PROFILE_SCHEMA = path.join(
  HARNESS_DIR,
  'schemas',
  'performance-profile-v1.schema.json',
);
const REPORT_SCHEMA = path.join(
  HARNESS_DIR,
  'schemas',
  'performance-report-v1.schema.json',
);
const WORKLOAD = path.join(HARNESS_DIR, 'workload.py');
const RUNNER = fileURLToPath(import.meta.url);
const LAUNCHER = process.platform === 'win32' ? 'shifu.cmd' : './shifu';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, 'utf8'));
}

function validator(schemaPath) {
  return new Ajv2020({ allErrors: true, strict: false }).compile(
    readJson(schemaPath),
  );
}

function validationError(validate) {
  return (validate.errors || [])
    .map((error) => `${error.instancePath || '/'} ${error.message}`)
    .join('; ');
}

export function loadProfile(name = 'cross-platform-v1') {
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(name)) {
    throw new Error(`invalid profile name '${name}'`);
  }
  const pathname = path.join(HARNESS_DIR, 'profiles', `${name}.json`);
  const raw = fs.readFileSync(pathname, 'utf8');
  const profile = JSON.parse(raw);
  const validate = validator(PROFILE_SCHEMA);
  if (!validate(profile)) {
    throw new Error(`profile schema invalid: ${validationError(validate)}`);
  }
  const platformKeys = profile.platforms.map(
    (entry) => `${entry.os}/${entry.arch}`,
  );
  if (new Set(platformKeys).size !== platformKeys.length) {
    throw new Error('profile platforms must be unique');
  }
  return { profile, pathname, raw, digest: sha256(raw) };
}

function git(args) {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? (result.stdout || '').trim() : null;
}

export function sourceFacts() {
  const status = git(['status', '--porcelain']);
  return {
    revision: git(['rev-parse', 'HEAD']) || 'unknown',
    tree: git(['rev-parse', 'HEAD^{tree}']) || 'unknown',
    dirty: status === null || status !== '',
  };
}

function quoteCmd(value) {
  if (/^[A-Za-z0-9_./:\\=-]+$/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/gu, '$1$1')}"`;
}

export function commandInvocation(
  command,
  platform = process.platform,
  env = process.env,
) {
  if (platform !== 'win32' || !/\.cmd$/iu.test(command[0])) {
    return { command: command[0], args: command.slice(1) };
  }
  return {
    command: env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `call ${command.map(quoteCmd).join(' ')}`],
  };
}

export function qualificationPlan(loaded, { quick = false } = {}) {
  const workload = [
    LAUNCHER,
    'exec',
    'uv',
    'run',
    '--project',
    'framework/core',
    '--frozen',
    'python',
    path.relative(ROOT, WORKLOAD),
    '--profile',
    path.relative(ROOT, loaded.pathname),
  ];
  if (quick) workload.push('--quick');
  return {
    setup: [LAUNCHER, 'build:core'],
    correctness: [LAUNCHER, loaded.profile.correctness_gate],
    workload,
  };
}

export function executeRetained(
  command,
  logPath,
  env = process.env,
  stderrLogPath = logPath,
) {
  const invocation = commandInvocation(command);
  const started = Date.now();
  const log = fs.openSync(logPath, 'wx');
  const splitStderr = stderrLogPath !== logPath;
  const stderrLog = splitStderr ? fs.openSync(stderrLogPath, 'wx') : log;
  let result;
  try {
    // Send both streams straight to retained storage. Besides removing the
    // fixed in-memory buffer, this avoids waiting for EOF on a captured pipe
    // after a Windows descendant inherited its handle. The direct child exit
    // remains authoritative, while a cancelled run still leaves a partial log
    // for diagnosis and artifact retention.
    result = spawnSync(invocation.command, invocation.args, {
      cwd: ROOT,
      env,
      stdio: ['ignore', log, stderrLog],
    });
  } finally {
    if (splitStderr) fs.closeSync(stderrLog);
    fs.closeSync(log);
  }
  const output = fs.readFileSync(logPath, 'utf8');
  return {
    status: result.status,
    output,
    stderrOutput: splitStderr ? fs.readFileSync(stderrLogPath, 'utf8') : output,
    durationMs: Date.now() - started,
    error: result.error,
  };
}

function plannedSuite(command) {
  return {
    command,
    status: 'planned',
    exit_code: null,
    duration_ms: 0,
    raw_log: null,
    raw_sha256: null,
  };
}

function retainSuite(outputDir, id, command, executed) {
  const filename = `${id}.log`;
  const pathname = path.join(outputDir, filename);
  if (!fs.existsSync(pathname)) {
    throw new Error(`${id} retained log is missing`);
  }
  return {
    command,
    status: executed.status === 0 && !executed.error ? 'passed' : 'failed',
    exit_code: executed.status ?? 1,
    duration_ms: executed.durationMs,
    raw_log: filename,
    raw_sha256: sha256(fs.readFileSync(pathname)),
  };
}

export function parseObservationStream(text) {
  const records = text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(
          `workload line ${index + 1} is not JSON: ${error.message}`,
        );
      }
    });
  const observations = records.filter(
    (record) =>
      record.schema === 'kungfu.python-kfx-asyncio.performance-observation/v1',
  );
  const manifests = records.filter(
    (record) =>
      record.schema === 'kungfu.python-kfx-asyncio.performance-manifest/v1',
  );
  const failures = records.filter(
    (record) =>
      record.schema === 'kungfu.python-kfx-asyncio.performance-failure/v1',
  );
  if (failures.length) throw new Error(`workload failed: ${failures[0].error}`);
  if (manifests.length !== 1) {
    throw new Error('workload must emit exactly one environment manifest');
  }
  if (!observations.length) throw new Error('workload emitted no observations');
  if (observations.some((record) => record.status !== 'passed')) {
    throw new Error('workload emitted a non-passing observation');
  }
  validatePeakRssObservations(observations);
  return { observations, manifest: manifests[0] };
}

function crediblePeakRss(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function validatePeakRssObservations(observations) {
  const invalid = observations.findIndex(
    (record) => !crediblePeakRss(record.peak_rss_bytes),
  );
  if (invalid !== -1) {
    throw new Error(
      `observation ${invalid + 1} peak_rss_bytes must be a positive safe integer`,
    );
  }
}

export function validateCoverage(
  observations,
  profile,
  { quick = false } = {},
) {
  const repetitions = quick ? 1 : profile.sampling.scored_repetitions;
  const concurrency = quick ? [1, 8] : profile.matrix.concurrency;
  const payloads = quick ? [64, 1024] : profile.matrix.payload_bytes;
  const expected = new Map();
  for (const value of concurrency) {
    for (const caseName of [
      'one-yield',
      'future-handoff',
      'cancel-timeout-error',
    ]) {
      expected.set(
        `raw-asyncio-scheduling|${caseName}|${value}|64`,
        repetitions,
      );
    }
    for (const payload of payloads) {
      expected.set(
        `async-capability-relay|round-trip|${value}|${payload}`,
        repetitions,
      );
    }
  }
  expected.set(
    'journal-asyncio-bridge|journal-callback-and-empty-pump|1|64',
    repetitions,
  );
  expected.set(
    'python-service-process-lifecycle|cold-launch-relay-and-graceful-shutdown|1|64',
    repetitions,
  );
  expected.set('bounded-relay-soak|relay-1024b-concurrency-8|8|1024', 1);

  const actual = new Map();
  for (const record of observations) {
    const key = [
      record.workload,
      record.case,
      record.concurrency,
      record.payload_bytes,
    ].join('|');
    if (!expected.has(key)) throw new Error(`unexpected observation '${key}'`);
    const records = actual.get(key) || [];
    records.push(record);
    actual.set(key, records);
  }
  for (const [key, count] of expected) {
    const records = actual.get(key) || [];
    if (records.length !== count) {
      throw new Error(
        `observation '${key}' count ${records.length} does not match ${count}`,
      );
    }
    const repetitionsSeen = records
      .map((record) => record.repetition)
      .sort((left, right) => left - right);
    assertDeepEqual(
      repetitionsSeen,
      Array.from({ length: count }, (_unused, index) => index),
      `observation '${key}' repetitions are incomplete or duplicated`,
    );
  }
  const required = new Set(profile.required_workloads);
  const observed = new Set(observations.map((record) => record.workload));
  assertDeepEqual(
    [...observed].sort(),
    [...required].sort(),
    'required workload coverage is incomplete',
  );
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(message);
  }
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : (ordered[middle - 1] + ordered[middle]) / 2;
}

export function deriveStatistics(observations) {
  const groups = new Map();
  for (const record of observations) {
    const key = [
      record.workload,
      record.case,
      record.concurrency,
      record.payload_bytes,
    ].join('|');
    const group = groups.get(key) || [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((records) => ({
      workload: records[0].workload,
      case: records[0].case,
      concurrency: records[0].concurrency,
      payload_bytes: records[0].payload_bytes,
      scored_repetitions: records.length,
      throughput_ops_per_second_median: median(
        records.map((record) => record.throughput_ops_per_second),
      ),
      p50_microseconds_median: median(
        records.map((record) => record.p50_microseconds),
      ),
      p95_microseconds_median: median(
        records.map((record) => record.p95_microseconds),
      ),
      p99_microseconds_median: median(
        records.map((record) => record.p99_microseconds),
      ),
      cpu_seconds_total: records.reduce(
        (sum, record) => sum + record.cpu_seconds,
        0,
      ),
      peak_rss_bytes_max: Math.max(
        ...records.map((record) => record.peak_rss_bytes),
      ),
      shutdown_milliseconds_max: Math.max(
        ...records.map((record) => record.shutdown_milliseconds),
      ),
      cancelled_operations_total: records.reduce(
        (sum, record) => sum + record.cancelled_operations,
        0,
      ),
      error_operations_total: records.reduce(
        (sum, record) => sum + record.error_operations,
        0,
      ),
      backpressure_peak_inflight_max: Math.max(
        ...records.map((record) => record.backpressure_peak_inflight),
      ),
    }))
    .sort((left, right) =>
      `${left.workload}|${left.case}|${left.concurrency}|${left.payload_bytes}`.localeCompare(
        `${right.workload}|${right.case}|${right.concurrency}|${right.payload_bytes}`,
      ),
    );
}

export function evaluateReport({
  mode,
  runId,
  source,
  loaded,
  setup,
  correctness,
  toolchainRoot = null,
  observations = [],
  rawPath = null,
  rawSha256 = null,
  manifest = null,
  quick = false,
}) {
  const platformEntry = loaded.profile.platforms.find(
    (entry) => entry.os === process.platform && entry.arch === process.arch,
  );
  const invalidations = [];
  if (mode === 'execute' && source.dirty)
    invalidations.push('source tree is dirty');
  if (
    !/^[0-9a-f]{40}$/u.test(source.revision) ||
    !/^[0-9a-f]{40}$/u.test(source.tree)
  )
    invalidations.push('source revision or tree cannot be resolved');
  if (!platformEntry)
    invalidations.push(
      `unsupported platform ${process.platform}/${process.arch}`,
    );
  if (mode === 'execute' && setup.status !== 'passed')
    invalidations.push('Core build failed');
  if (mode === 'execute' && correctness.status !== 'passed')
    invalidations.push('correctness gate failed');
  if (mode === 'execute' && !observations.length)
    invalidations.push('scored observations are missing');
  if (
    mode === 'execute' &&
    observations.some((record) => !crediblePeakRss(record.peak_rss_bytes))
  )
    invalidations.push('peak RSS observation is missing or non-credible');
  if (mode === 'execute' && quick)
    invalidations.push('quick workload is diagnostic-only');
  if (
    mode === 'execute' &&
    manifest?.python &&
    !/^3\.13\./u.test(manifest.python)
  )
    invalidations.push(`unsupported CPython ${manifest.python}`);
  const failed = [setup, correctness].some(
    (suite) => suite.status === 'failed',
  );
  const qualified = mode === 'execute' && !failed && invalidations.length === 0;
  return {
    schema: 'kungfu.python-kfx-asyncio.performance-report/v1',
    run_id: runId,
    verdict:
      mode === 'dry-run'
        ? 'planned'
        : failed
          ? 'failed'
          : qualified
            ? 'qualified'
            : 'unqualified',
    source,
    environment: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
      cpu_count: os.cpus().length,
      cpu_model: os.cpus()[0]?.model || 'unknown',
      total_memory_bytes: os.totalmem(),
      python: manifest?.python || null,
      python_implementation: manifest?.implementation || null,
      platform_claim: platformEntry?.claim || null,
    },
    roots: {
      profile: `sha256:${loaded.digest}`,
      runner: `sha256:${sha256(fs.readFileSync(RUNNER))}`,
      workload: `sha256:${sha256(fs.readFileSync(WORKLOAD))}`,
      toolchain: toolchainRoot,
    },
    profile: loaded.profile.name,
    setup,
    correctness,
    observations: {
      count: observations.length,
      raw_path: rawPath,
      raw_sha256: rawSha256,
    },
    statistics: deriveStatistics(observations),
    claims: {
      service_plane_envelope_qualified: qualified,
      journal_hot_path_qualified: false,
      universal_performance_promise: false,
    },
    invalidations,
  };
}

export function validateReport(report) {
  const validate = validator(REPORT_SCHEMA);
  if (!validate(report)) {
    throw new Error(`report schema invalid: ${validationError(validate)}`);
  }
}

function retainedFile(evidenceDir, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error(`${label} path is missing`);
  }
  const root = path.resolve(evidenceDir);
  const pathname = path.resolve(root, relativePath);
  const relative = path.relative(root, pathname);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} path escapes the evidence directory`);
  }
  return pathname;
}

function verifyRetainedSuite(evidenceDir, name, suite) {
  if (suite.status !== 'passed' || suite.exit_code !== 0) {
    throw new Error(`${name} suite is not passing`);
  }
  const pathname = retainedFile(evidenceDir, suite.raw_log, `${name} log`);
  const raw = fs.readFileSync(pathname);
  if (sha256(raw) !== suite.raw_sha256) {
    throw new Error(`${name} log digest does not match the report`);
  }
}

export function verifyEvidence(
  evidenceDir,
  loaded = loadProfile(),
  exactSource = sourceFacts(),
) {
  const reportPath = path.join(evidenceDir, 'report.json');
  const report = readJson(reportPath);
  validateReport(report);
  if (report.verdict !== 'qualified') {
    throw new Error(`evidence verdict is ${report.verdict}, not qualified`);
  }
  if (report.source.dirty) throw new Error('evidence source is dirty');
  if (report.profile !== loaded.profile.name) {
    throw new Error('evidence profile does not match the verification profile');
  }
  if (report.invalidations.length !== 0) {
    throw new Error('qualified evidence retains invalidations');
  }
  if (
    report.claims.service_plane_envelope_qualified !== true ||
    report.claims.journal_hot_path_qualified !== false ||
    report.claims.universal_performance_promise !== false
  ) {
    throw new Error('evidence claim boundary is inconsistent');
  }
  if (exactSource.dirty) throw new Error('verification checkout is dirty');
  if (
    report.source.revision !== exactSource.revision ||
    report.source.tree !== exactSource.tree
  ) {
    throw new Error('evidence source does not match the verification checkout');
  }
  const roots = {
    profile: `sha256:${loaded.digest}`,
    runner: `sha256:${sha256(fs.readFileSync(RUNNER))}`,
    workload: `sha256:${sha256(fs.readFileSync(WORKLOAD))}`,
  };
  for (const [name, value] of Object.entries(roots)) {
    if (report.roots[name] !== value) {
      throw new Error(`${name} root does not match the verification checkout`);
    }
  }
  if (!report.roots.toolchain) {
    throw new Error('qualified evidence is missing its toolchain root');
  }
  const toolchainPath = retainedFile(
    evidenceDir,
    'toolchain.log',
    'toolchain log',
  );
  if (
    `sha256:${sha256(fs.readFileSync(toolchainPath))}` !==
    report.roots.toolchain
  ) {
    throw new Error('toolchain log digest does not match the report');
  }
  const platformEntry = loaded.profile.platforms.find(
    (entry) =>
      entry.os === report.environment.os &&
      entry.arch === report.environment.arch,
  );
  if (
    !platformEntry ||
    report.environment.platform_claim !== platformEntry.claim
  ) {
    throw new Error('evidence platform does not match the qualified profile');
  }
  if (
    report.environment.python_implementation !== 'CPython' ||
    !/^3\.13\./u.test(report.environment.python || '')
  ) {
    throw new Error('evidence does not use the qualified CPython 3.13 line');
  }
  const expectedRunId = `${report.source.revision.slice(0, 12)}-${report.environment.os}-${report.environment.arch}`;
  if (report.run_id !== expectedRunId) {
    throw new Error('evidence run id does not match its source and platform');
  }
  verifyRetainedSuite(evidenceDir, 'setup', report.setup);
  verifyRetainedSuite(evidenceDir, 'correctness', report.correctness);
  const rawPath = retainedFile(
    evidenceDir,
    report.observations.raw_path,
    'raw observations',
  );
  const raw = fs.readFileSync(rawPath, 'utf8');
  if (sha256(raw) !== report.observations.raw_sha256) {
    throw new Error('raw observation digest does not match the report');
  }
  const observations = raw
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (
    observations.some(
      (record) =>
        record.schema !==
          'kungfu.python-kfx-asyncio.performance-observation/v1' ||
        record.status !== 'passed',
    )
  ) {
    throw new Error(
      'raw observations contain an invalid or non-passing record',
    );
  }
  validatePeakRssObservations(observations);
  if (observations.length !== report.observations.count) {
    throw new Error('raw observation count does not match the report');
  }
  validateCoverage(observations, loaded.profile);
  assertDeepEqual(
    deriveStatistics(observations),
    report.statistics,
    'derived statistics do not match the complete raw observations',
  );
  const summaryPath = retainedFile(evidenceDir, 'summary.md', 'summary');
  if (fs.readFileSync(summaryPath, 'utf8') !== renderSummary(report, loaded)) {
    throw new Error('human-readable summary does not match the report');
  }
  return report;
}

export function renderSummary(report, loaded) {
  const lines = [
    '# Python KFX asyncio performance qualification',
    '',
    `- Verdict: **${report.verdict}**`,
    `- Source: \`${report.source.revision}\` (tree \`${report.source.tree}\`)`,
    `- Platform: ${report.environment.platform_claim || `${report.environment.os}/${report.environment.arch}`}`,
    `- CPython: ${report.environment.python || 'planned'}`,
    `- Profile root: \`${report.roots.profile}\``,
    `- Runner root: \`${report.roots.runner}\``,
    `- Workload root: \`${report.roots.workload}\``,
    `- Toolchain root: \`${report.roots.toolchain || 'planned'}\``,
    `- Raw observations: ${report.observations.count}`,
    '',
    '## Claim boundary',
    '',
    `- Qualified: ${loaded.profile.claim_boundary.qualified}`,
    `- Advisory: ${loaded.profile.claim_boundary.advisory}`,
    `- Unqualified: ${loaded.profile.claim_boundary.unqualified}`,
    '',
    '## Invalidations',
    '',
    ...(report.invalidations.length
      ? report.invalidations.map((item) => `- ${item}`)
      : ['- None']),
    '',
    'No observation was deleted or selectively excluded.',
    '',
  ];
  return lines.join('\n');
}

function parseArgs(argv) {
  const options = {
    mode: 'dry-run',
    profile: 'cross-platform-v1',
    output: null,
    quick: false,
    verify: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--execute') options.mode = 'execute';
    else if (arg === '--dry-run') options.mode = 'dry-run';
    else if (arg === '--quick') options.quick = true;
    else if (arg === '--verify') options.verify = argv[++index];
    else if (arg === '--profile') options.profile = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else throw new Error(`unknown argument '${arg}'`);
  }
  return options;
}

function defaultOutput(runId) {
  return path.join(
    ROOT,
    '.buildchain',
    'runtime',
    'qualification',
    'python-kfx-asyncio-performance',
    runId,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const loaded = loadProfile(options.profile);
  if (options.verify) {
    const report = verifyEvidence(path.resolve(options.verify), loaded);
    process.stdout.write(
      `[python-kfx-asyncio-performance] verified run=${report.run_id} source=${report.source.revision}\n`,
    );
    return;
  }
  const source = sourceFacts();
  const runId = `${source.revision.slice(0, 12)}-${process.platform}-${process.arch}`;
  const plan = qualificationPlan(loaded, { quick: options.quick });
  if (options.mode === 'dry-run') {
    const report = evaluateReport({
      mode: 'dry-run',
      runId,
      source,
      loaded,
      setup: plannedSuite(plan.setup),
      correctness: plannedSuite(plan.correctness),
    });
    validateReport(report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  if (source.dirty) throw new Error('execute requires a clean source tree');
  const outputDir = path.resolve(options.output || defaultOutput(runId));
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  fs.mkdirSync(outputDir, { recursive: false });

  const setupExecution = executeRetained(
    plan.setup,
    path.join(outputDir, 'setup.log'),
  );
  const setup = retainSuite(outputDir, 'setup', plan.setup, setupExecution);
  let correctness = plannedSuite(plan.correctness);
  let workloadExecution = {
    status: 1,
    output: '',
    durationMs: 0,
  };
  let observations = [];
  let manifest = null;
  let rawPath = null;
  let rawDigest = null;
  let toolchainRoot = null;
  let evidenceSource = source;
  if (setup.status === 'passed') {
    const doctor = executeRetained(
      [LAUNCHER, 'doctor', '--json'],
      path.join(outputDir, 'toolchain.log'),
    );
    if (doctor.status === 0) toolchainRoot = `sha256:${sha256(doctor.output)}`;
    const correctnessExecution = executeRetained(
      plan.correctness,
      path.join(outputDir, 'correctness.log'),
    );
    correctness = retainSuite(
      outputDir,
      'correctness',
      plan.correctness,
      correctnessExecution,
    );
    if (correctness.status === 'passed') {
      evidenceSource = sourceFacts();
      if (
        !evidenceSource.dirty &&
        evidenceSource.revision === source.revision &&
        evidenceSource.tree === source.tree
      ) {
        workloadExecution = executeRetained(
          plan.workload,
          path.join(outputDir, 'workload.log'),
          {
            ...process.env,
            KUNGFU_ALLOW_FOREIGN_RUNTIME: '1',
          },
          path.join(outputDir, 'workload.stderr.log'),
        );
      } else {
        workloadExecution.output =
          'source drifted during setup or correctness; measurement skipped\n';
        fs.writeFileSync(
          path.join(outputDir, 'workload.log'),
          workloadExecution.output,
          {
            encoding: 'utf8',
            flag: 'wx',
          },
        );
      }
      if (workloadExecution.status === 0) {
        try {
          const parsed = parseObservationStream(workloadExecution.output);
          validateCoverage(parsed.observations, loaded.profile, {
            quick: options.quick,
          });
          observations = parsed.observations;
          manifest = parsed.manifest;
          rawPath = 'raw-observations.jsonl';
          const raw = observations
            .map((item) => `${JSON.stringify(item)}\n`)
            .join('');
          fs.writeFileSync(path.join(outputDir, rawPath), raw, {
            encoding: 'utf8',
            flag: 'wx',
          });
          rawDigest = sha256(raw);
        } catch (error) {
          workloadExecution.status = 1;
          fs.appendFileSync(
            path.join(outputDir, 'workload.log'),
            `\n[harness-validation] ${error.message}\n`,
          );
        }
      }
    }
  }
  const report = evaluateReport({
    mode: 'execute',
    runId,
    source: evidenceSource,
    loaded,
    setup,
    correctness,
    toolchainRoot,
    observations,
    rawPath,
    rawSha256: rawDigest,
    manifest,
    quick: options.quick,
  });
  if (workloadExecution.status !== 0 && correctness.status === 'passed') {
    report.invalidations.push('performance workload failed');
    report.verdict = 'failed';
    report.claims.service_plane_envelope_qualified = false;
  }
  validateReport(report);
  fs.writeFileSync(
    path.join(outputDir, 'report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  fs.writeFileSync(
    path.join(outputDir, 'summary.md'),
    renderSummary(report, loaded),
    {
      encoding: 'utf8',
      flag: 'wx',
    },
  );
  process.stdout.write(
    `[python-kfx-asyncio-performance] verdict=${report.verdict} output=${outputDir}\n`,
  );
  if (report.verdict === 'failed') process.exitCode = 1;
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`[python-kfx-asyncio-performance] ${error.message}\n`);
    process.exitCode = 1;
  });
}
