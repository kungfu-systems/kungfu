#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { cmdCommand } from './run-shifu-lifecycle.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LAUNCHER = process.platform === 'win32' ? 'shifu.cmd' : './shifu';
const SCHEMA = 'kungfu.zero-burden-desktop.qualification/v1';

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
    command: cmdCommand(path.win32.join(root, 'shifu.cmd'), args),
    args: [],
    shell: options.comspec || env.ComSpec || env.COMSPEC || 'cmd.exe',
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

function runSuite(suite, outputDir) {
  const started = Date.now();
  const invocation = qualificationSuiteInvocation(suite);
  console.log(`[zero-burden-qualify] running ${suite.id}`);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: ROOT,
    env: qualificationSuiteEnvironment(),
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...(invocation.shell ? { shell: invocation.shell } : {}),
  });
  const launchError = result.error
    ? `[zero-burden-qualify] launch_error=${result.error.stack || String(result.error)}\n`
    : '';
  const output = `${launchError}${result.stdout || ''}${result.stderr || ''}`;
  const rawLog = `${suite.id}.log`;
  fs.writeFileSync(path.join(outputDir, rawLog), output, { flag: 'wx' });
  const passed = !result.error && result.status === 0;
  console.log(
    `[zero-burden-qualify] suite=${suite.id} status=${passed ? 'passed' : 'failed'} duration_ms=${Date.now() - started}`,
  );
  return {
    id: suite.id,
    command: suite.command,
    status: passed ? 'passed' : 'failed',
    exit_code: result.status,
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
  const suites = QUALIFICATION_SUITES.map((suite) =>
    runSuite(suite, outputDir),
  );
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
