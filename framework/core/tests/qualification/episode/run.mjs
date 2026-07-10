// SPDX-License-Identifier: Apache-2.0
//
// Cross-platform coordinator for the Episode Qualification Harness.
// Profiles, process isolation, timeouts, aggregation, and the Trust Report live
// here. Python workers call the real C++-backed Episode surface and write one
// private result file each; workers never contend on the report itself.
// @ts-check

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const harnessDir = path.dirname(__filename);
const coreDir = path.resolve(harnessDir, '..', '..', '..');
const rootDir = path.resolve(coreDir, '..', '..');
const workerPath = path.join(harnessDir, 'episode_workload.py');
const semanticWorkerPath = path.join(harnessDir, 'semantic_workload.py');
const schemaPath = path.join(
  harnessDir,
  'schemas',
  'trust-report-v2.schema.json',
);
const semanticDimensionNames = [
  'lifecycle_safety',
  'capability_soundness',
  'useful_degradation',
  'repair_monotonicity',
  'dependency_containment',
  'projection_derivation',
  'publication_recovery',
  'content_integrity',
  'portable_identity',
];

function usage() {
  console.log(`Episode Qualification Harness

Usage:
  ./kungfu-code episode:qualify -- [options]

Options:
  --profile NAME                     mvp-smoke-v1 (default) or mvp-baseline-v1
  --mode all|accumulation|contention|semantic selected scenario family (default: all)
  --seed N                           override profile seeds with one seed
  --accumulation-checkpoints A,B     override accumulation checkpoints
  --contention-episodes N            override fixed contention Episode count
  --workers A,B                      override contention worker counts
  --report PATH                      Trust Report destination
  --keep-runtime                     retain generated runtime homes
  -h, --help                         show this help
`);
}

function fail(message) {
  console.error(`episode qualification: ${message}`);
  process.exit(2);
}

function parseInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(`${label} must be a non-negative safe integer, got '${value}'`);
  }
  return parsed;
}

function parseIntegerList(value, label, allowZero = false) {
  const values = value
    .split(',')
    .filter(Boolean)
    .map((item) => parseInteger(item, label));
  if (
    values.length === 0 ||
    (!allowZero && values.some((item) => item === 0))
  ) {
    fail(`${label} must contain positive comma-separated integers`);
  }
  return values;
}

function parseArgs(argv) {
  const options = {
    profile: 'mvp-smoke-v1',
    mode: 'all',
    seed: null,
    accumulationCheckpoints: null,
    contentionEpisodes: null,
    workers: null,
    report: null,
    keepRuntime: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    const next = () => {
      index += 1;
      if (index >= argv.length) fail(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--profile') options.profile = next();
    else if (arg === '--mode') options.mode = next();
    else if (arg === '--seed') options.seed = parseInteger(next(), '--seed');
    else if (arg === '--accumulation-checkpoints') {
      options.accumulationCheckpoints = parseIntegerList(
        next(),
        '--accumulation-checkpoints',
      );
    } else if (arg === '--contention-episodes') {
      options.contentionEpisodes = parseInteger(
        next(),
        '--contention-episodes',
      );
      if (options.contentionEpisodes === 0) {
        fail('--contention-episodes must be positive');
      }
    } else if (arg === '--workers') {
      options.workers = parseIntegerList(next(), '--workers');
    } else if (arg === '--report') options.report = path.resolve(next());
    else if (arg === '--keep-runtime') options.keepRuntime = true;
    else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else fail(`unknown argument '${arg}'`);
  }
  if (
    !['all', 'accumulation', 'contention', 'semantic'].includes(options.mode)
  ) {
    fail(
      `--mode must be all, accumulation, contention, or semantic, got '${options.mode}'`,
    );
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.profile)) {
    fail(`invalid profile name '${options.profile}'`);
  }
  return options;
}

function loadProfile(options) {
  const profilePath = path.join(
    harnessDir,
    'profiles',
    `${options.profile}.json`,
  );
  if (!fs.existsSync(profilePath)) fail(`profile not found: ${profilePath}`);
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  if (profile.schema !== 'kungfu.episode.qualification-profile/v1') {
    fail(`unsupported profile schema '${profile.schema}'`);
  }
  if (profile.name !== options.profile) {
    fail(`profile name '${profile.name}' does not match ${options.profile}`);
  }
  if (options.seed != null) profile.seeds = [options.seed];
  if (options.accumulationCheckpoints) {
    profile.accumulation.checkpoints = options.accumulationCheckpoints;
  }
  if (options.contentionEpisodes != null) {
    profile.contention.total_episodes = options.contentionEpisodes;
  }
  if (options.workers) profile.contention.workers = options.workers;
  for (const key of ['seeds']) {
    if (!Array.isArray(profile[key]) || profile[key].length === 0) {
      fail(`profile ${key} must be a non-empty array`);
    }
  }
  if (
    !profile.semantic ||
    !Array.isArray(profile.semantic.required_dimensions) ||
    profile.semantic.required_dimensions.length === 0 ||
    !Number.isSafeInteger(profile.semantic.timeout_seconds) ||
    profile.semantic.timeout_seconds <= 0
  ) {
    fail(
      'profile semantic policy must declare required_dimensions and timeout_seconds',
    );
  }
  const unknownDimensions = profile.semantic.required_dimensions.filter(
    (dimension) => !semanticDimensionNames.includes(dimension),
  );
  if (unknownDimensions.length > 0) {
    fail(
      `profile has unknown semantic dimensions: ${unknownDimensions.join(',')}`,
    );
  }
  return profile;
}

function runtimeEnv() {
  const dist = path.join(coreDir, 'dist', 'kungfu');
  const env = { ...process.env };
  const key =
    process.platform === 'darwin'
      ? 'DYLD_FALLBACK_LIBRARY_PATH'
      : process.platform === 'win32'
        ? 'PATH'
        : 'LD_LIBRARY_PATH';
  env[key] = env[key] ? `${dist}${path.delimiter}${env[key]}` : dist;
  return env;
}

function assertNativeBinding() {
  const dist = path.join(coreDir, 'dist', 'kungfu');
  let entries = [];
  try {
    entries = fs.readdirSync(dist);
  } catch {
    // handled below
  }
  if (!entries.some((name) => /^pykungfu.*\.(so|pyd)$/.test(name))) {
    fail(
      `native binding not found under ${dist}; run './kungfu-code build:core' first`,
    );
  }
}

function gitText(args) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function readResult(resultPath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      kind: fallback.kind,
      errors: [
        {
          code: 'worker_result_missing',
          error: `${error}`,
          process: fallback,
        },
      ],
    };
  }
}

function runPython(args, resultPath, timeoutSeconds, scriptPath = workerPath) {
  return new Promise((resolve) => {
    const child = spawn(
      'uv',
      ['run', '--frozen', 'python', scriptPath, ...args],
      {
        cwd: coreDir,
        env: runtimeEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-20000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-20000);
    });
    child.on('error', (error) => {
      stderr = `${stderr}\n${error}`.slice(-20000);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutSeconds * 1000);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const processResult = {
        kind: args[0],
        exit_code: code,
        signal,
        timed_out: timedOut,
        stdout_tail: stdout.trim().slice(-2000),
        stderr_tail: stderr.trim().slice(-4000),
      };
      const result = readResult(resultPath, processResult);
      result.process = processResult;
      if (timedOut) {
        result.ok = false;
        result.errors = [
          ...(result.errors || []),
          { code: 'scenario_timeout', timeout_seconds: timeoutSeconds },
        ];
      }
      resolve(result);
    });
  });
}

function retryArgs(profile) {
  return [
    '--initial-delay-ms',
    String(profile.retry.initial_delay_ms),
    '--max-delay-ms',
    String(profile.retry.max_delay_ms),
    '--max-attempts',
    String(profile.retry.max_attempts),
    '--progress-timeout-ms',
    String(profile.retry.progress_timeout_ms),
  ];
}

function probeArgs(profile, values) {
  const args = [
    'probe',
    '--result',
    values.resultPath,
    '--runtime-dir',
    values.runtimeDir,
    '--mode',
    values.mode,
    '--seed',
    String(values.seed),
    '--expected-count',
    String(values.expectedCount),
    '--logical-agents',
    String(values.logicalAgents),
    '--abort-every',
    String(values.abortEvery),
    '--sample-count',
    String(profile.validation.sample_count),
    '--list-limit',
    String(profile.validation.list_limit),
  ];
  for (const warning of profile.validation.allowed_full_fsck_warnings) {
    args.push('--allowed-warning', warning);
  }
  return args;
}

function removeRuntime(runtimeDir, keepRuntime) {
  if (!keepRuntime) fs.rmSync(runtimeDir, { recursive: true, force: true });
}

async function runAccumulation(profile, seed, runRoot, keepRuntime) {
  const runtimeDir = path.join(runRoot, 'runtime', `accumulation-${seed}`);
  fs.mkdirSync(runtimeDir, { recursive: true });
  const scenarios = [];
  let previous = 0;
  for (const checkpoint of profile.accumulation.checkpoints) {
    if (!Number.isSafeInteger(checkpoint) || checkpoint <= previous) {
      fail('accumulation checkpoints must be positive and strictly increasing');
    }
    const resultPath = path.join(
      runRoot,
      'results',
      `accumulation-${seed}-${checkpoint}-write.json`,
    );
    const write = await runPython(
      [
        'write',
        '--result',
        resultPath,
        '--runtime-dir',
        runtimeDir,
        '--mode',
        'accumulation',
        '--seed',
        String(seed),
        '--start-index',
        String(previous),
        '--count',
        String(checkpoint - previous),
        '--logical-agents',
        '1',
        '--worker-id',
        '0',
        '--abort-every',
        String(profile.accumulation.abort_every),
        ...retryArgs(profile),
      ],
      resultPath,
      profile.scenario_timeout_seconds,
    );
    const probePath = path.join(
      runRoot,
      'results',
      `accumulation-${seed}-${checkpoint}-probe.json`,
    );
    const probe = await runPython(
      probeArgs(profile, {
        resultPath: probePath,
        runtimeDir,
        mode: 'accumulation',
        seed,
        expectedCount: checkpoint,
        logicalAgents: 1,
        abortEvery: profile.accumulation.abort_every,
      }),
      probePath,
      profile.scenario_timeout_seconds,
    );
    scenarios.push({
      kind: 'accumulation',
      seed,
      checkpoint,
      added_episodes: checkpoint - previous,
      write,
      probe,
      ok: Boolean(write.ok && probe.ok),
    });
    previous = checkpoint;
    if (!write.ok || !probe.ok) break;
  }
  removeRuntime(runtimeDir, keepRuntime);
  return scenarios;
}

async function runContention(profile, seed, workerCount, runRoot, keepRuntime) {
  const total = profile.contention.total_episodes;
  const runtimeDir = path.join(
    runRoot,
    'runtime',
    `contention-${seed}-${workerCount}`,
  );
  fs.mkdirSync(runtimeDir, { recursive: true });
  const startAtMs = Date.now() + 1000;
  let nextIndex = 0;
  const promises = [];
  for (let workerId = 0; workerId < workerCount; workerId += 1) {
    const base = Math.floor(total / workerCount);
    const count = base + (workerId < total % workerCount ? 1 : 0);
    const resultPath = path.join(
      runRoot,
      'results',
      `contention-${seed}-${workerCount}-worker-${workerId}.json`,
    );
    promises.push(
      runPython(
        [
          'write',
          '--result',
          resultPath,
          '--runtime-dir',
          runtimeDir,
          '--mode',
          'contention',
          '--seed',
          String(seed),
          '--start-index',
          String(nextIndex),
          '--count',
          String(count),
          '--logical-agents',
          String(workerCount),
          '--worker-id',
          String(workerId),
          '--abort-every',
          String(profile.contention.abort_every),
          '--start-at-ms',
          String(startAtMs),
          ...retryArgs(profile),
        ],
        resultPath,
        profile.scenario_timeout_seconds,
      ),
    );
    nextIndex += count;
  }
  const workers = await Promise.all(promises);
  const probePath = path.join(
    runRoot,
    'results',
    `contention-${seed}-${workerCount}-probe.json`,
  );
  const probe = await runPython(
    probeArgs(profile, {
      resultPath: probePath,
      runtimeDir,
      mode: 'contention',
      seed,
      expectedCount: total,
      logicalAgents: workerCount,
      abortEvery: profile.contention.abort_every,
    }),
    probePath,
    profile.scenario_timeout_seconds,
  );
  const scenario = {
    kind: 'contention',
    seed,
    workers: workerCount,
    total_episodes: total,
    writer_results: workers,
    probe,
    ok: Boolean(workers.every((result) => result.ok) && probe.ok),
  };
  removeRuntime(runtimeDir, keepRuntime);
  return scenario;
}

async function runSemantic(profile, runRoot, keepRuntime) {
  const runtimeRoot = path.join(runRoot, 'runtime', 'semantic-v1');
  const resultPath = path.join(runRoot, 'results', 'semantic-v1.json');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const result = await runPython(
    ['--result', resultPath, '--runtime-root', runtimeRoot],
    resultPath,
    profile.semantic.timeout_seconds,
    semanticWorkerPath,
  );
  removeRuntime(runtimeRoot, keepRuntime);
  return result;
}

function sumWorkerOperation(scenarios, field) {
  let total = 0;
  for (const scenario of scenarios) {
    const workers = scenario.writer_results || [scenario.write].filter(Boolean);
    for (const worker of workers) total += worker.operations?.[field] || 0;
  }
  return total;
}

function writerResults(scenario) {
  return scenario.writer_results || [scenario.write].filter(Boolean);
}

function aggregateWriters(workers) {
  const durationSeconds = Math.max(
    0,
    ...workers.map((worker) => worker.duration_seconds || 0),
  );
  const episodesCompleted = workers.reduce(
    (total, worker) => total + (worker.episodes_completed || 0),
    0,
  );
  const operations = {};
  for (const field of [
    'successful_appends',
    'manifest_writer_busy',
    'retry_count',
    'retry_exhausted',
    'unexpected_errors',
    'progress_timeouts',
  ]) {
    operations[field] = workers.reduce(
      (total, worker) => total + (worker.operations?.[field] || 0),
      0,
    );
  }
  operations.longest_no_progress_interval_ms = Math.max(
    0,
    ...workers.map(
      (worker) => worker.operations?.longest_no_progress_interval_ms || 0,
    ),
  );
  return {
    episodes_completed: episodesCompleted,
    duration_seconds: durationSeconds,
    throughput_episodes_per_second:
      durationSeconds > 0 ? episodesCompleted / durationSeconds : 0,
    operations,
    max_worker_rss_bytes: Math.max(
      0,
      ...workers.map((worker) => worker.resources?.max_rss_bytes || 0),
    ),
  };
}

function probeErrors(scenarios) {
  return scenarios.flatMap((scenario) => scenario.probe?.errors || []);
}

function countCodes(errors, predicate) {
  return errors.filter((error) => predicate(String(error.code || ''))).length;
}

function workloadScenario(scenario) {
  if (scenario.kind === 'accumulation') {
    return {
      kind: scenario.kind,
      seed: scenario.seed,
      checkpoint: scenario.checkpoint,
      added_episodes: scenario.added_episodes,
      ok: scenario.ok,
    };
  }
  return {
    kind: scenario.kind,
    seed: scenario.seed,
    workers: scenario.workers,
    total_episodes: scenario.total_episodes,
    ok: scenario.ok,
  };
}

function performanceScenario(scenario) {
  const workers = writerResults(scenario);
  return {
    ...workloadScenario(scenario),
    aggregate: aggregateWriters(workers),
    writers: workers.map((worker) => ({
      worker_id: worker.worker_id,
      episodes_completed: worker.episodes_completed,
      duration_seconds: worker.duration_seconds,
      throughput_episodes_per_second: worker.throughput_episodes_per_second,
      operations: worker.operations,
      latency_ms: worker.latency_ms,
      resources: worker.resources,
    })),
    readback: scenario.probe
      ? {
          expected_episodes: scenario.probe.expected_episodes,
          listed_episodes: scenario.probe.listed_episodes,
          expected_semantic_records: scenario.probe.expected_semantic_records,
          listed_semantic_records: scenario.probe.listed_semantic_records,
          observed_manifest_frames: scenario.probe.observed_manifest_frames,
          manifest_control_frames: scenario.probe.manifest_control_frames,
          sample_indices: scenario.probe.sample_indices,
          sampled_readback_ok: scenario.probe.sampled_readback_ok,
          metrics: scenario.probe.metrics,
          resources: scenario.probe.resources,
          fsck: scenario.probe.fsck,
          recovery: scenario.probe.recovery,
        }
      : null,
    diagnostics: {
      writer_errors: workers.flatMap((worker) => worker.errors || []),
      writer_processes: workers.map((worker) => worker.process || null),
      probe_errors: scenario.probe?.errors || [],
      probe_process: scenario.probe?.process || null,
    },
  };
}

async function validateReport(reportPath) {
  const child = spawnSync(
    'uv',
    [
      'run',
      '--frozen',
      'python',
      workerPath,
      'validate-report',
      '--report',
      reportPath,
      '--schema',
      schemaPath,
    ],
    {
      cwd: coreDir,
      env: runtimeEnv(),
      encoding: 'utf8',
    },
  );
  return {
    ok: child.status === 0,
    output: `${child.stdout || ''}${child.stderr || ''}`.trim().slice(-4000),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const profile = loadProfile(options);
  assertNativeBinding();

  const runRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kf-episode-qualification-'),
  );
  fs.mkdirSync(path.join(runRoot, 'results'), { recursive: true });
  const reportPath =
    options.report || path.join(runRoot, 'episode-trust-report.json');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  const sourceRevision = gitText(['rev-parse', 'HEAD']);
  const sourceDirty = gitText(['status', '--porcelain']).length > 0;
  const started = Date.now();
  const scenarios = [];
  let semantic = null;

  console.log(
    `[episode-qualify] profile=${profile.name} mode=${options.mode} seeds=${profile.seeds.join(',')}`,
  );
  for (const seed of profile.seeds) {
    if (options.mode === 'all' || options.mode === 'accumulation') {
      console.log(
        `[episode-qualify] accumulation seed=${seed} checkpoints=${profile.accumulation.checkpoints.join(',')}`,
      );
      scenarios.push(
        ...(await runAccumulation(profile, seed, runRoot, options.keepRuntime)),
      );
    }
    if (options.mode === 'all' || options.mode === 'contention') {
      for (const workers of profile.contention.workers) {
        console.log(
          `[episode-qualify] contention seed=${seed} workers=${workers} episodes=${profile.contention.total_episodes}`,
        );
        scenarios.push(
          await runContention(
            profile,
            seed,
            workers,
            runRoot,
            options.keepRuntime,
          ),
        );
      }
    }
  }
  if (options.mode === 'all' || options.mode === 'semantic') {
    console.log('[episode-qualify] semantic oracle and production comparisons');
    semantic = await runSemantic(profile, runRoot, options.keepRuntime);
  }

  const errors = probeErrors(scenarios);
  const retryExhausted = sumWorkerOperation(scenarios, 'retry_exhausted');
  const unexpectedErrors = scenarios.reduce((total, scenario) => {
    let scenarioTotal = 0;
    for (const worker of writerResults(scenario)) {
      if (worker.operations) {
        scenarioTotal += worker.operations.unexpected_errors || 0;
      } else {
        scenarioTotal += (worker.errors || []).length;
      }
    }
    return total + scenarioTotal;
  }, 0);
  const progressTimeouts =
    sumWorkerOperation(scenarios, 'progress_timeouts') +
    countCodes(errors, (code) => code === 'scenario_timeout');
  const correctness = {
    count_mismatches: countCodes(errors, (code) =>
      code.includes('count_mismatch'),
    ),
    readback_mismatches: countCodes(errors, (code) =>
      code.includes('readback_mismatch'),
    ),
    fsck_failures: countCodes(errors, (code) => code.includes('fsck_failed')),
    recovery_mismatches: countCodes(errors, (code) =>
      code.includes('recovery'),
    ),
    retry_exhausted: retryExhausted,
    unexpected_errors: unexpectedErrors,
    progress_timeouts: progressTimeouts,
  };
  const metadataSelected = ['all', 'accumulation', 'contention'].includes(
    options.mode,
  );
  const metadataScenariosOk =
    !metadataSelected ||
    (scenarios.length > 0 && scenarios.every((scenario) => scenario.ok));
  const semanticSelected = ['all', 'semantic'].includes(options.mode);
  const requiredSemanticDimensions = profile.semantic.required_dimensions;
  const semanticDimensions =
    semantic?.dimensions ||
    Object.fromEntries(
      semanticDimensionNames.map((dimension) => [
        dimension,
        {
          status: 'not_exercised',
          cases_executed: 0,
          violations: [],
          evidence: [],
          reason: `invocation selected only the ${options.mode} scenario family`,
        },
      ]),
    );
  const requiredSemanticPassed = requiredSemanticDimensions.every(
    (dimension) => semanticDimensions[dimension]?.status === 'passed',
  );
  const selectedExecutionOk =
    metadataScenariosOk &&
    (!semanticSelected || (Boolean(semantic?.ok) && requiredSemanticPassed));
  const contentionScenarios = scenarios.filter(
    (scenario) => scenario.kind === 'contention' && scenario.workers > 1,
  );
  const busyObserved =
    sumWorkerOperation(scenarios, 'manifest_writer_busy') > 0;
  const durationSeconds = (Date.now() - started) / 1000;
  const gaps = [
    'metadata-only profile; realistic payload bytes and dedup are not exercised',
    'semantic dependency coverage is bounded to direct dependencies; generated DAG depth and fan-out are not exercised',
    'Episode projection derivation is exercised, but large projection rebuild cost is not measured',
    'single-node local filesystem only; no service-backed or distributed qualification',
    'publication coverage exercises an interrupted open Episode; torn journal/page crash points remain in deterministic fixtures',
    'no absolute performance SLO is adopted by the v0 profile',
  ];
  if (options.mode !== 'all') {
    gaps.push(`invocation selected only the ${options.mode} scenario family`);
  }
  if (sourceDirty) {
    gaps.push(
      'source worktree was dirty; commit the exact source before a release claim',
    );
  }

  const report = {
    schema: 'kungfu.episode.trust-report/v2',
    source_revision: sourceRevision,
    source_dirty: sourceDirty,
    episode_contract: 'kungfu.episode.manifest/v1',
    profile: profile.name,
    platform: {
      os: process.platform,
      arch: process.arch,
      node: process.version,
    },
    hardware: {
      logical_cpus: os.cpus().length,
      total_memory_bytes: os.totalmem(),
    },
    backend_capabilities: {
      manifest_authority: 'yijinjing-journal',
      writer_ownership: 'one-logical-manifest-writer-per-data-root',
      payload_profile: profile.payload_profile,
      query_profile: profile.query_profile,
      retry_policy: profile.retry,
    },
    workload: {
      profile: profile.name,
      seeds: profile.seeds,
      duration_seconds: durationSeconds,
      scenarios: scenarios.map(workloadScenario),
    },
    fault_coverage: {
      writer_contention_exercised: contentionScenarios.length > 0,
      writer_contention_observed: busyObserved,
      fresh_process_readback:
        scenarios.length > 0 &&
        scenarios.every((scenario) => Boolean(scenario.probe?.ok)),
      clean_recovery:
        scenarios.length > 0 &&
        scenarios.every(
          (scenario) => scenario.probe?.recovery?.recovered_count === 0,
        ),
      interrupted_open_recovery:
        semanticDimensions.publication_recovery?.status === 'passed',
      missing_content_and_hash_rejection:
        semanticDimensions.content_integrity?.status === 'passed',
      dependency_failure_containment:
        semanticDimensions.dependency_containment?.status === 'passed',
      projection_drift_and_rebuild:
        semanticDimensions.projection_derivation?.status === 'passed',
    },
    correctness,
    semantic_evidence: {
      oracle: semantic?.oracle || 'kungfu.episode.semantic-oracle/v1',
      oracle_check: semantic?.oracle_check || {
        status: 'not_exercised',
        histories_checked: 0,
        violation: `invocation selected only the ${options.mode} scenario family`,
      },
      required_dimensions: requiredSemanticDimensions,
      dimensions: semanticDimensions,
      cases: semantic?.cases || [],
      process: semantic?.process || null,
    },
    performance: {
      scenarios: scenarios.map(performanceScenario),
    },
    gaps,
    qualified:
      options.mode === 'all' &&
      metadataScenariosOk &&
      Boolean(semantic?.ok) &&
      requiredSemanticPassed &&
      !sourceDirty,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const schemaValidation = await validateReport(reportPath);
  if (!schemaValidation.ok) {
    console.error(
      `[episode-qualify] report schema invalid: ${schemaValidation.output}`,
    );
  }

  console.log(`[episode-qualify] report=${reportPath}`);
  console.log(
    `[episode-qualify] scenarios=${scenarios.length} passed=${scenarios.filter((scenario) => scenario.ok).length} busy=${sumWorkerOperation(scenarios, 'manifest_writer_busy')} qualified=${report.qualified}`,
  );
  if (sourceDirty && selectedExecutionOk) {
    console.log(
      '[episode-qualify] scenario gates passed, but release qualification remains false for a dirty source tree',
    );
  }
  process.exitCode = selectedExecutionOk && schemaValidation.ok ? 0 : 1;
}

await main();
