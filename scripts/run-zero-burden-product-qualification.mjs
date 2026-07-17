#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { windowsCmdArgs } from './run-shifu-lifecycle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = process.platform === 'win32' ? 'shifu.cmd' : './shifu';
const SCHEMA = 'kungfu.zero-burden-desktop.qualification/v1';
const DEFAULT_SUITE_TIMEOUT_MS = 30 * 60 * 1000;
const SUITE_TERMINATION_GRACE_MS = 5 * 1000;

const COMPONENTS = [
  {
    id: 'live-peer-continuity',
    directory: 'product/release/qualification/live-peer-continuity',
  },
  {
    id: 'runtime-activation',
    directory: 'product/release/qualification/runtime-activation',
  },
];

export const QUALIFICATION_SUITES = [
  {
    id: 'agent-session-control-plane',
    command: [
      LAUNCHER,
      '--filter',
      '@kungfu-tech/agent-session',
      'test:control-plane',
    ],
  },
  {
    id: 'frontend-product-presentation',
    command: [LAUNCHER, '--filter', '@kungfu-tech/kfx-view-terminal', 'test'],
  },
];

export function qualificationSuiteEnvironment(inherited = process.env) {
  const hostTemporary = inherited.KUNGFU_QUALIFICATION_HOST_TEMP;
  if (!hostTemporary) return inherited;
  return {
    ...inherited,
    TMPDIR: hostTemporary,
    TEMP: hostTemporary,
    TMP: hostTemporary,
  };
}

export function qualificationSuiteInvocation(suite, options = {}) {
  const platform = options.platform || process.platform;
  const root = options.root || ROOT;
  const [command, ...args] = suite.command;
  if (platform !== 'win32' || command !== 'shifu.cmd') return { command, args };
  const env = options.env || process.env;
  return {
    command: options.comspec || env.ComSpec || env.COMSPEC || 'cmd.exe',
    args: windowsCmdArgs(path.win32.join(root, 'shifu.cmd'), args),
    windowsVerbatimArguments: true,
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
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

export function validateComponentEvidence(root, component, expected) {
  const directory = path.resolve(root, component.directory);
  const reportPath = path.join(directory, 'report.json');
  const bundlePath = path.join(directory, 'raw-logs.jsonl.gz');
  if (!fs.existsSync(reportPath) || !fs.existsSync(bundlePath)) {
    throw new Error(
      `${component.id} must retain report.json beside raw-logs.jsonl.gz`,
    );
  }
  const reportBytes = fs.readFileSync(reportPath);
  const bundleBytes = fs.readFileSync(bundlePath);
  const report = JSON.parse(reportBytes);
  const declaredBundle = report.artifacts?.log_bundle;
  if (report.verdict !== 'passed')
    throw new Error(`${component.id} report verdict is not passed`);
  if (report.source?.revision !== expected.sourceRevision)
    throw new Error(`${component.id} report source revision does not match`);
  if (
    report.platform?.os !== expected.platform.os ||
    report.platform?.arch !== expected.platform.arch
  )
    throw new Error(`${component.id} report platform does not match`);
  if (!declaredBundle || declaredBundle.path !== 'raw-logs.jsonl.gz')
    throw new Error(`${component.id} report does not bind the raw log bundle`);
  if (declaredBundle.sha256 !== sha256(bundleBytes))
    throw new Error(`${component.id} raw log bundle digest does not match`);
  return {
    id: component.id,
    report: path.relative(root, reportPath).split(path.sep).join('/'),
    report_sha256: sha256(reportBytes),
    raw_logs: path.relative(root, bundlePath).split(path.sep).join('/'),
    raw_logs_sha256: sha256(bundleBytes),
    raw_logs_bytes: bundleBytes.length,
    verdict: report.verdict,
    claims: report.claims || {},
  };
}

function suiteTimeout(environment = process.env) {
  const configured = environment.KUNGFU_ZERO_BURDEN_SUITE_TIMEOUT_MS;
  if (!configured) return DEFAULT_SUITE_TIMEOUT_MS;
  const timeout = Number(configured);
  if (!Number.isSafeInteger(timeout) || timeout <= 0)
    throw new Error(
      'KUNGFU_ZERO_BURDEN_SUITE_TIMEOUT_MS must be a positive integer',
    );
  return timeout;
}

function terminateSuiteProcess(child, platform = process.platform) {
  if (!child.pid) return 'qualification suite has no process id to terminate';
  if (platform === 'win32') {
    const result = spawnSync(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      { encoding: 'utf8', windowsHide: true },
    );
    return [result.error?.message, result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
    return '';
  } catch (error) {
    child.kill('SIGTERM');
    return error?.message || String(error);
  }
}

export async function runSuite(suite, outputDir, options = {}) {
  const started = Date.now();
  const platform = options.platform || process.platform;
  const environment = options.env || process.env;
  const timeoutMs = options.timeoutMs || suiteTimeout(environment);
  const invocation = qualificationSuiteInvocation(suite, {
    platform,
    root: options.root || ROOT,
    env: environment,
    comspec: options.comspec,
  });
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const chunks = [];
  const append = (target, chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    chunks.push(bytes);
    target.write(bytes);
  };
  console.log(
    `[zero-burden-qualify] running ${suite.id} timeout_ms=${timeoutMs}`,
  );
  const child = (options.spawn || spawn)(invocation.command, invocation.args, {
    cwd: options.root || ROOT,
    env: qualificationSuiteEnvironment(environment),
    detached: platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
    ...(invocation.shell ? { shell: invocation.shell } : {}),
  });
  child.stdout?.on('data', (chunk) => append(stdout, chunk));
  child.stderr?.on('data', (chunk) => append(stderr, chunk));

  let launchError = null;
  let timedOut = false;
  const result = await new Promise((resolve) => {
    let settled = false;
    let graceTimer = null;
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ exitCode, signal });
    };
    child.once('error', (error) => {
      launchError = error;
      append(
        stderr,
        `[zero-burden-qualify] launch_error=${error.stack || String(error)}\n`,
      );
    });
    child.once('close', finish);
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      append(
        stderr,
        `[zero-burden-qualify] suite=${suite.id} timed_out_after_ms=${timeoutMs}\n`,
      );
      const diagnostic = terminateSuiteProcess(child, platform);
      if (diagnostic)
        append(stderr, `[zero-burden-qualify] termination=${diagnostic}\n`);
      graceTimer = setTimeout(
        () => finish(child.exitCode, child.signalCode),
        SUITE_TERMINATION_GRACE_MS,
      );
    }, timeoutMs);
  });
  const output = Buffer.concat(chunks);
  const rawLog = `${suite.id}.log`;
  fs.writeFileSync(path.join(outputDir, rawLog), output, { flag: 'wx' });
  const passed = !launchError && !timedOut && result.exitCode === 0;
  console.log(
    `[zero-burden-qualify] suite=${suite.id} status=${passed ? 'passed' : 'failed'} duration_ms=${Date.now() - started}`,
  );
  return {
    id: suite.id,
    command: suite.command,
    status: passed ? 'passed' : 'failed',
    exit_code: result.exitCode,
    signal: result.signal,
    timed_out: timedOut,
    timeout_ms: timeoutMs,
    duration_ms: Date.now() - started,
    raw_log: rawLog,
    raw_sha256: sha256(output),
  };
}

function createLogBundle(outputDir, suites) {
  const entries = suites.map((suite) => {
    const content = fs.readFileSync(path.join(outputDir, suite.raw_log));
    return {
      suite_id: suite.id,
      path: suite.raw_log,
      sha256: sha256(content),
      bytes: content.length,
      content_base64: content.toString('base64'),
    };
  });
  const payload = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
  const bundle = gzipSync(Buffer.from(payload), { level: 9 });
  const bundleName = 'raw-logs.jsonl.gz';
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

export function evaluateQualification({
  source,
  platform,
  components,
  suites,
  bundle,
}) {
  const componentPassed = (id) =>
    components.find((component) => component.id === id)?.verdict === 'passed';
  const suitePassed = (id) =>
    suites.find((suite) => suite.id === id)?.status === 'passed';
  const runtime = components.find(
    (component) => component.id === 'runtime-activation',
  );
  const passed =
    !source.dirty &&
    componentPassed('live-peer-continuity') &&
    componentPassed('runtime-activation') &&
    suites.every((suite) => suite.status === 'passed') &&
    Boolean(bundle);
  const violations = [];
  if (source.dirty)
    violations.push('source tree is dirty; evidence is not source-exact');
  if (!componentPassed('live-peer-continuity'))
    violations.push('live Peer continuity evidence is missing or failed');
  if (!componentPassed('runtime-activation'))
    violations.push('runtime activation evidence is missing or failed');
  if (!suites.every((suite) => suite.status === 'passed'))
    violations.push(
      'Agent Session or frontend presentation qualification failed',
    );
  return {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    source,
    platform,
    components,
    suites,
    coverage: {
      runtime_activation_and_self_maintenance:
        componentPassed('runtime-activation'),
      live_peer_control_plane_continuity: componentPassed(
        'live-peer-continuity',
      ),
      capsule_provider_and_reattach_faults: suitePassed(
        'agent-session-control-plane',
      ),
      rebuildable_frontend_product_projection: suitePassed(
        'frontend-product-presentation',
      ),
      product_artifact_build_and_verification:
        runtime?.claims?.product_artifacts_verified === true,
      report_and_raw_signal_retention:
        components.length === COMPONENTS.length && Boolean(bundle),
    },
    claims: {
      normal_single_host_zero_burden_runtime: passed,
      product_artifacts_verified:
        passed && runtime?.claims?.product_artifacts_verified === true,
      authenticated_provider_dogfood: false,
      interactive_gui_lifecycle: false,
      physical_host_restart_or_power_loss: false,
      cross_host_high_availability: false,
    },
    non_claims: [
      'authenticated Codex or Claude provider behavior from credential-free CI',
      'interactive GUI pixels, window lifecycle, or desktop input from headless automation',
      'physical reboot, logout, sudden power loss, or hardware failure',
      'cross-host replication, consensus, or high availability',
      'Linux or Windows packaged-product dogfood from another platform report',
    ],
    artifacts: { log_bundle: bundle },
    violations,
    verdict: passed ? 'passed' : 'failed',
  };
}

function parseArgs(argv) {
  const value = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : null;
  };
  return { output: value('--output'), retain: value('--retain') };
}

function writeJson(pathname, value) {
  const temporary = `${pathname}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
  });
  fs.renameSync(temporary, pathname);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(
    args.output ||
      path.join(
        ROOT,
        '.buildchain',
        'runtime',
        'qualification',
        'zero-burden-desktop',
        `zero-burden-${Date.now()}-${process.pid}`,
      ),
  );
  fs.mkdirSync(outputDir, { recursive: true });
  const source = sourceFacts();
  const platform = {
    os: process.platform,
    arch: process.arch,
    release: os.release(),
  };
  const expected = { sourceRevision: source.revision, platform };
  const components = COMPONENTS.map((component) =>
    validateComponentEvidence(ROOT, component, expected),
  );
  const suites = [];
  for (const suite of QUALIFICATION_SUITES)
    suites.push(await runSuite(suite, outputDir));
  const bundle = createLogBundle(outputDir, suites);
  const report = evaluateQualification({
    source,
    platform,
    components,
    suites,
    bundle,
  });
  writeJson(path.join(outputDir, 'report.json'), report);
  if (args.retain) {
    const retainDir = path.resolve(ROOT, args.retain);
    fs.mkdirSync(retainDir, { recursive: true });
    for (const artifact of ['report.json', 'raw-logs.jsonl.gz'])
      fs.copyFileSync(
        path.join(outputDir, artifact),
        path.join(retainDir, artifact),
        fs.constants.COPYFILE_EXCL,
      );
    console.log(`[zero-burden-qualify] retained=${retainDir}`);
  }
  console.log(
    `[zero-burden-qualify] verdict=${report.verdict} report=${path.join(outputDir, 'report.json')}`,
  );
  if (report.verdict !== 'passed') process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
