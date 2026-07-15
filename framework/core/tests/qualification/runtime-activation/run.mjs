// SPDX-License-Identifier: Apache-2.0
// @ts-check

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import Ajv2020 from 'ajv/dist/2020.js';

import { cmdCommand } from '../../../../../scripts/run-shifu-lifecycle.mjs';

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HARNESS_DIR, '..', '..', '..', '..', '..');
const REPORT_SCHEMA_PATH = path.join(
  HARNESS_DIR,
  'schemas',
  'runtime-activation-qualification-report-v1.schema.json',
);
const LAUNCHER = process.platform === 'win32' ? 'shifu.cmd' : './shifu';

export const SUITES = [
  {
    id: 'activation-core',
    product: false,
    command: [
      LAUNCHER,
      'exec',
      'uv',
      'run',
      '--project',
      'framework/core',
      'python',
      '-m',
      'pytest',
      'framework/core/tests/python/test_runtime_broker.py',
      'framework/core/tests/python/test_runtime_service.py',
      '-q',
    ],
  },
  {
    id: 'product-distribution',
    product: true,
    command: [LAUNCHER, 'dist'],
  },
  {
    id: 'profile-action-admission',
    product: false,
    command: [
      LAUNCHER,
      'exec',
      'uv',
      'run',
      '--project',
      'framework/core',
      'node',
      'scripts/run-agent-profile-sdk-tests.mjs',
    ],
  },
  {
    id: 'runtime-surface-parity',
    product: false,
    command: [LAUNCHER, 'test:runtime-surface'],
  },
  {
    id: 'activation-performance',
    product: false,
    command: [
      LAUNCHER,
      'exec',
      'uv',
      'run',
      '--project',
      'framework/core',
      'python',
      'framework/core/tests/qualification/runtime-activation/performance_workload.py',
    ],
  },
  {
    id: 'product-runtime-smoke',
    product: true,
    command: [
      LAUNCHER,
      'exec',
      process.execPath,
      'framework/core/tests/qualification/runtime-activation/product_smoke.mjs',
    ],
  },
  {
    id: 'product-verification',
    product: true,
    // product-distribution has just built the complete product, and the outer
    // release qualification has already run the Episode campaign. Verify these
    // exact outputs without starting a second native rebuild or duplicating an
    // unrelated Episode campaign inside the artifact-verification suite.
    command: [LAUNCHER, 'verify', '--with-app', '--skip-episode-qualification'],
  },
  {
    id: 'product-catalog',
    product: true,
    command: [LAUNCHER, 'builds', '--json'],
  },
];

const COVERAGE = {
  'daemonless-storage': ['activation-core'],
  'direct-no-fork-coordinator': ['activation-core'],
  'process-crash-recovery': ['activation-core'],
  'on-demand-runtime-self-maintenance': ['activation-core'],
  'native-readiness-publication': ['activation-core'],
  'profile-action-admission': ['profile-action-admission'],
  'language-product-parity': ['runtime-surface-parity'],
  'bounded-latency-and-resource-report': ['activation-performance'],
  'product-artifact-build': ['product-distribution'],
  'temporary-product-runtime-smoke': ['product-runtime-smoke'],
  'product-artifact-verification': ['product-verification'],
  'product-artifact-catalog': ['product-catalog'],
};

const NON_CLAIMS = [
  'production EmbeddedRuntimeHost',
  'distributed election, cross-machine leases, or high availability',
  'physical-host power-loss qualification from process-crash evidence',
  'default-on production durability or projection candidate profiles',
  'universal startup, recovery, or activation latency SLO',
  'readiness descriptor bytes as authority without native revalidation',
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function createLogBundle(outputDir, suites) {
  const entries = suites
    .filter((suite) => suite.raw_log)
    .map((suite) => {
      const pathname = path.join(outputDir, suite.raw_log);
      const content = fs.readFileSync(pathname);
      return {
        suite_id: suite.id,
        path: suite.raw_log,
        sha256: sha256(content),
        bytes: content.length,
        content_base64: content.toString('base64'),
      };
    });
  if (!entries.length) return null;
  const bundleName = 'raw-logs.jsonl.gz';
  const payload = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
  const bundle = gzipSync(Buffer.from(payload), { level: 9 });
  fs.writeFileSync(path.join(outputDir, bundleName), bundle, { flag: 'wx' });
  return {
    path: bundleName,
    media_type: 'application/x-ndjson',
    content_encoding: 'gzip',
    sha256: sha256(bundle),
    bytes: bundle.length,
    entries: entries.map(({ content_base64: _content, ...entry }) => entry),
  };
}

export function retainQualificationArtifacts(outputDir, retainDir, artifacts) {
  fs.mkdirSync(retainDir, { recursive: true });
  for (const artifact of artifacts) {
    fs.copyFileSync(
      path.join(outputDir, artifact),
      path.join(retainDir, artifact),
      fs.constants.COPYFILE_EXCL,
    );
  }
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

export function qualificationPlan({ mode, withProduct }) {
  return SUITES.map((suite) => {
    const required = !suite.product || withProduct;
    return {
      id: suite.id,
      command: [...suite.command],
      required,
      status: mode === 'dry-run' ? 'planned' : required ? 'planned' : 'skipped',
      exit_code: null,
      duration_ms: 0,
      raw_log: null,
      raw_sha256: null,
    };
  });
}

export function defaultOutputDir(runId) {
  return path.join(
    ROOT,
    '.buildchain',
    'runtime',
    'qualification',
    'runtime-activation',
    runId,
  );
}

function coverageStatus(ids, suites, mode) {
  const evidence = ids.map((id) => suites.find((suite) => suite.id === id));
  if (mode === 'dry-run') return 'planned';
  if (evidence.some((suite) => !suite || suite.status === 'skipped')) {
    return 'unqualified';
  }
  return evidence.every((suite) => suite.status === 'passed')
    ? 'passed'
    : 'failed';
}

export function evaluateQualification({
  mode,
  withProduct,
  source,
  platform,
  suites,
  runId,
  artifacts = null,
}) {
  const coverage = Object.entries(COVERAGE).map(([id, evidenceSuites]) => ({
    id,
    evidence_suites: evidenceSuites,
    status: coverageStatus(evidenceSuites, suites, mode),
  }));
  const violations = [];
  if (mode === 'execute' && source.dirty) {
    violations.push('source tree is dirty; evidence is not source-exact');
  }
  if (mode === 'execute' && !withProduct) {
    violations.push('product artifact qualification was omitted');
  }
  const failed = suites.some(
    (suite) => suite.required && suite.status === 'failed',
  );
  const complete = suites
    .filter((suite) => suite.required)
    .every((suite) => suite.status === 'passed');
  const passed =
    mode === 'execute' &&
    withProduct &&
    !source.dirty &&
    !failed &&
    complete &&
    coverage.every((item) => item.status === 'passed');
  const corePassed = (id) =>
    suites.find((suite) => suite.id === id)?.status === 'passed';
  const report = {
    schema: 'kungfu.runtime-activation.qualification-report/v1',
    run_id: runId,
    mode,
    product_mode: withProduct ? 'required' : 'omitted',
    source,
    platform,
    suites,
    coverage,
    claims: {
      daemonless_storage_operations: passed && corePassed('activation-core'),
      direct_no_fork_coordinator: passed && corePassed('activation-core'),
      process_crash_recovery: passed && corePassed('activation-core'),
      native_readiness_publication: passed && corePassed('activation-core'),
      product_artifacts_verified:
        passed &&
        corePassed('product-distribution') &&
        corePassed('product-runtime-smoke') &&
        corePassed('product-verification') &&
        corePassed('product-catalog'),
      embedded_runtime_host: false,
    },
    non_claims: NON_CLAIMS,
    violations,
    verdict:
      mode === 'dry-run'
        ? 'planned'
        : failed
          ? 'failed'
          : passed
            ? 'passed'
            : 'unqualified',
  };
  if (artifacts) report.artifacts = artifacts;
  return report;
}

export function suiteInvocation(suite, options = {}) {
  const platform = options.platform || process.platform;
  const root = options.root || ROOT;
  const env = options.env || process.env;
  const [command, ...args] = suite.command;
  if (platform !== 'win32' || command !== 'shifu.cmd') {
    return { command, args };
  }
  const comspec = options.comspec || env.ComSpec || env.COMSPEC || 'cmd.exe';
  return {
    command: comspec,
    args: [
      '/d',
      '/s',
      '/c',
      `call ${cmdCommand(path.join(root, 'shifu.cmd'), args)}`,
    ],
  };
}

function runSuite(suite, outputDir) {
  console.log(`[runtime-activation-qualify] running ${suite.id}`);
  const started = Date.now();
  const invocation = suiteInvocation(suite);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    env: {
      ...process.env,
      ...(suite.id === 'activation-core' ||
      suite.id === 'activation-performance'
        ? {
            PYTHONPATH: [
              path.join(ROOT, 'framework', 'core', 'src', 'python'),
              process.env.PYTHONPATH,
            ]
              .filter(Boolean)
              .join(path.delimiter),
          }
        : {}),
    },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  });
  const launchError = result.error
    ? `[runtime-activation-qualify] launch_error=${result.error.stack || String(result.error)}\n`
    : '';
  const output = `${result.stdout || ''}${result.stderr || ''}${launchError}`;
  const rawName = `${suite.id}.log`;
  fs.writeFileSync(path.join(outputDir, rawName), output, { flag: 'wx' });
  const passed = !result.error && result.status === 0;
  console.log(
    `[runtime-activation-qualify] suite=${suite.id} status=${passed ? 'passed' : 'failed'} duration_ms=${Date.now() - started}`,
  );
  return {
    ...suite,
    status: passed ? 'passed' : 'failed',
    exit_code: result.status,
    duration_ms: Date.now() - started,
    raw_log: rawName,
    raw_sha256: sha256(output),
  };
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  const mode = value('--mode') || 'dry-run';
  if (!['dry-run', 'execute'].includes(mode)) {
    throw new Error(`invalid --mode '${mode}'`);
  }
  return {
    mode,
    withProduct: argv.includes('--with-product'),
    output: value('--output'),
    retain: value('--retain'),
  };
}

function writeJson(pathname, value) {
  const temporary = `${pathname}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
  });
  fs.renameSync(temporary, pathname);
}

export function validateReport(report) {
  const schema = JSON.parse(fs.readFileSync(REPORT_SCHEMA_PATH, 'utf8'));
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    schema,
  );
  if (!validate(report)) {
    throw new Error(
      `runtime activation report schema invalid: ${JSON.stringify(validate.errors)}`,
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = `runtime-activation-${Date.now()}-${process.pid}`;
  const outputDir = path.resolve(args.output || defaultOutputDir(runId));
  fs.mkdirSync(outputDir, { recursive: true });
  let suites = qualificationPlan(args);
  if (args.mode === 'execute') {
    suites = suites.map((suite) =>
      suite.required ? runSuite(suite, outputDir) : suite,
    );
  }
  const logBundle =
    args.mode === 'execute' ? createLogBundle(outputDir, suites) : null;
  const report = evaluateQualification({
    ...args,
    source: sourceFacts(),
    platform: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
    },
    suites,
    runId,
    artifacts: logBundle ? { log_bundle: logBundle } : null,
  });
  validateReport(report);
  const reportPath = path.join(outputDir, 'report.json');
  writeJson(reportPath, report);
  if (args.retain) {
    const retainDir = path.resolve(ROOT, args.retain);
    retainQualificationArtifacts(outputDir, retainDir, [
      'report.json',
      ...(logBundle ? [logBundle.path] : []),
    ]);
    console.log(`[runtime-activation-qualify] retained=${retainDir}`);
  }
  console.log(
    `[runtime-activation-qualify] verdict=${report.verdict} report=${reportPath}`,
  );
  if (args.mode === 'execute' && report.verdict !== 'passed') process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
