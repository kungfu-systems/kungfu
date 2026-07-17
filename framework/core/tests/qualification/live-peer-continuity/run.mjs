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

const HARNESS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HARNESS_DIR, '..', '..', '..', '..', '..');
const SCHEMA = 'kungfu.runtime.live-peer-continuity-qualification/v1';

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

export function pythonInvocation({ platform = process.platform } = {}) {
  return {
    command: [
      'uv',
      'run',
      '--frozen',
      '--project',
      path.join(ROOT, 'framework', 'core'),
      'python',
    ],
    shell: platform === 'win32',
  };
}

export function campaignTempParent(
  platform = process.platform,
  { env = process.env, temporaryDirectory = os.tmpdir() } = {},
) {
  if (platform !== 'win32') return '/tmp';
  // Release qualification deliberately redirects TEMP/TMP into the repository
  // for native build performance. That path can exceed Windows AF_UNIX limits
  // once the campaign appends its runtime endpoint hierarchy. GitHub exposes a
  // shorter runner-owned root that remains isolated to the current job.
  return (
    env.RUNNER_TEMP || env.KUNGFU_QUALIFICATION_HOST_TEMP || temporaryDirectory
  );
}

function nativeEnvironment() {
  const build = path.join(ROOT, 'framework', 'core', 'build', 'Release');
  const env = {
    ...process.env,
    PYTHONPATH: [
      path.join(ROOT, 'framework', 'core', 'src', 'python'),
      build,
      process.env.PYTHONPATH,
    ]
      .filter(Boolean)
      .join(path.delimiter),
  };
  if (process.platform !== 'darwin') return env;
  const store = path.join(ROOT, 'node_modules', '.pnpm');
  if (!fs.existsSync(store)) return env;
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x64';
  const packageName = fs
    .readdirSync(store)
    .find((name) =>
      name.startsWith(`@kungfu-tech+libnode-darwin-${architecture}@`),
    );
  if (!packageName) return env;
  const libnode = path.join(
    store,
    packageName,
    'node_modules',
    '@kungfu-tech',
    `libnode-darwin-${architecture}`,
    'dist',
    'node',
  );
  env.DYLD_LIBRARY_PATH = [libnode, process.env.DYLD_LIBRARY_PATH]
    .filter(Boolean)
    .join(path.delimiter);
  return env;
}

export function qualificationPlan(
  outputDir,
  { platform = process.platform } = {},
) {
  const python = pythonInvocation({ platform });
  const tempParent = campaignTempParent(platform);
  return [
    {
      id: 'peer-lifecycle-control-plane',
      command: [
        ...python.command,
        '-m',
        'pytest',
        'framework/core/tests/python/test_peer_lifecycle.py',
        '-q',
      ],
      env: nativeEnvironment(),
      shell: python.shell,
    },
    {
      id: 'core-continuity-state-machine',
      command: [
        'ctest',
        '--test-dir',
        'framework/core/build/src/libkungfu',
        '--output-on-failure',
        '--no-tests=error',
        '-R',
        '^kungfu_peer_continuity_tests$',
      ],
      env: process.env,
    },
    {
      id: 'agent-session-capsule-continuity',
      command: [
        process.execPath,
        '--test',
        'framework/agent-session/tests/peer-transport.test.mjs',
      ],
      env: process.env,
    },
    {
      id: 'native-cross-process-restart',
      command: [
        ...python.command,
        path.join(HARNESS_DIR, 'native_campaign.py'),
        'campaign',
        '--output-dir',
        path.join(outputDir, 'native-campaign'),
        ...(tempParent ? ['--temp-parent', tempParent] : []),
      ],
      env: nativeEnvironment(),
      shell: python.shell,
    },
  ];
}

function runSuite(suite, outputDir) {
  const started = Date.now();
  const result = spawnSync(suite.command[0], suite.command.slice(1), {
    cwd: ROOT,
    env: suite.env,
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    shell: suite.shell || false,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const rawLog = `${suite.id}.log`;
  fs.writeFileSync(path.join(outputDir, rawLog), output, { flag: 'wx' });
  const passed = !result.error && result.status === 0;
  if (!passed && suite.id === 'native-cross-process-restart') {
    const campaign = nativeCampaignReport(outputDir);
    const detail =
      campaign?.error || result.error?.message || 'campaign report unavailable';
    console.error(`[live-peer-continuity] native-campaign-error=${detail}`);
    for (const diagnostic of nativeFailureDiagnosticTails(outputDir)) {
      console.error(
        `[live-peer-continuity] native-log-tail-start path=${diagnostic.path}\n${diagnostic.tail}\n[live-peer-continuity] native-log-tail-end path=${diagnostic.path}`,
      );
    }
  }
  console.log(
    `[live-peer-continuity] suite=${suite.id} status=${passed ? 'passed' : 'failed'} duration_ms=${Date.now() - started}`,
  );
  return {
    id: suite.id,
    command: suite.command.map((part) =>
      path.isAbsolute(part) ? path.relative(ROOT, part) || '.' : part,
    ),
    status: passed ? 'passed' : 'failed',
    exit_code: result.status,
    duration_ms: Date.now() - started,
    raw_log: rawLog,
    raw_sha256: sha256(output),
  };
}

function evidenceFiles(outputDir) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path
        .relative(outputDir, absolute)
        .split(path.sep)
        .join('/');
      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        relative !== 'report.json' &&
        relative !== 'raw-logs.jsonl.gz'
      )
        files.push({ absolute, relative });
    }
  };
  visit(outputDir);
  return files.sort((left, right) =>
    left.relative.localeCompare(right.relative),
  );
}

export function createLogBundle(outputDir) {
  const entries = evidenceFiles(outputDir).map(({ absolute, relative }) => {
    const content = fs.readFileSync(absolute);
    return {
      path: relative,
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

function nativeCampaignReport(outputDir) {
  const pathname = path.join(outputDir, 'native-campaign', 'report.json');
  if (!fs.existsSync(pathname)) return null;
  try {
    return JSON.parse(fs.readFileSync(pathname, 'utf8'));
  } catch {
    return null;
  }
}

export function boundedDiagnosticTail(
  logPath,
  { maxBytes = 16 * 1024, maxLines = 40 } = {},
) {
  if (!fs.existsSync(logPath)) return null;
  const content = fs.readFileSync(logPath);
  const tail = content.subarray(Math.max(0, content.length - maxBytes));
  return tail
    .toString('utf8')
    .replaceAll('\r\n', '\n')
    .trimEnd()
    .split('\n')
    .slice(-maxLines)
    .join('\n')
    .trimStart();
}

export function nativeFailureDiagnosticTails(outputDir) {
  const campaignDir = path.join(outputDir, 'native-campaign');
  if (!fs.existsSync(campaignDir)) return [];
  return fs
    .readdirSync(campaignDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name === 'peer.log' ||
          /^coordinator(?:-.+)?\.log$/u.test(entry.name)),
    )
    .map((entry) => ({
      path: entry.name,
      tail: boundedDiagnosticTail(path.join(campaignDir, entry.name)),
    }))
    .filter((entry) => entry.tail)
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function evaluateQualification({
  source,
  platform,
  suites,
  campaign,
  bundle,
}) {
  const failed = suites.some((suite) => suite.status === 'failed');
  const requiredSuites = [
    'peer-lifecycle-control-plane',
    'core-continuity-state-machine',
    'agent-session-capsule-continuity',
    'native-cross-process-restart',
  ];
  const suiteStatus = new Map(suites.map((suite) => [suite.id, suite.status]));
  const complete = requiredSuites.every(
    (id) => suiteStatus.get(id) === 'passed',
  );
  const campaignPassed = campaign?.verdict === 'passed';
  const lifecycleCampaignPassed =
    campaignPassed &&
    campaign?.coverage?.peerHostCrashAdopted === true &&
    campaign?.coverage?.staleHostGenerationRejected === true &&
    campaign?.coverage?.peerCrashRestarted === true &&
    campaign?.coverage?.peerGenerationAdvanced === true;
  const violations = [];
  if (source.dirty)
    violations.push('source tree is dirty; evidence is not source-exact');
  if (!complete)
    violations.push('one or more required qualification suites did not pass');
  if (!campaignPassed)
    violations.push(
      'native cross-process campaign did not produce a passing report',
    );
  if (campaignPassed && !lifecycleCampaignPassed)
    violations.push('Peer lifecycle fault coverage is incomplete');
  const passed =
    !source.dirty && !failed && complete && lifecycleCampaignPassed;
  return {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    source,
    platform,
    suites,
    coverage: {
      peer_lifecycle_control_plane:
        suiteStatus.get('peer-lifecycle-control-plane') === 'passed',
      core_state_machine:
        suiteStatus.get('core-continuity-state-machine') === 'passed',
      agent_session_capsule:
        suiteStatus.get('agent-session-capsule-continuity') === 'passed',
      capsule_process_restart_campaign:
        campaign?.coverage?.capsulePidPreserved === true &&
        campaign?.coverage?.capsuleStreamEpochPreserved === true,
      hard_coordinator_crash: campaignPassed,
      stale_authority_rejection: campaignPassed,
      peer_pid_preserved: campaign?.coverage?.peerPidPreserved === true,
      peer_host_crash_adopted:
        campaign?.coverage?.peerHostCrashAdopted === true,
      stale_host_generation_rejected:
        campaign?.coverage?.staleHostGenerationRejected === true,
      peer_crash_restarted: campaign?.coverage?.peerCrashRestarted === true,
    },
    claims: {
      single_host_process_continuity: passed,
      physical_power_loss: false,
      cross_host_high_availability: false,
    },
    native_campaign: campaign,
    artifacts: { log_bundle: bundle },
    violations,
    verdict: failed ? 'failed' : passed ? 'passed' : 'unqualified',
  };
}

export function retainQualificationArtifacts(outputDir, retainDir) {
  fs.mkdirSync(retainDir, { recursive: true });
  for (const artifact of ['report.json', 'raw-logs.jsonl.gz'])
    fs.copyFileSync(
      path.join(outputDir, artifact),
      path.join(retainDir, artifact),
      fs.constants.COPYFILE_EXCL,
    );
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

export function defaultOutputDir(runId) {
  return path.join(
    ROOT,
    '.buildchain',
    'runtime',
    'qualification',
    'live-peer-continuity',
    runId,
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = `live-peer-continuity-${Date.now()}-${process.pid}`;
  const outputDir = path.resolve(args.output || defaultOutputDir(runId));
  fs.mkdirSync(outputDir, { recursive: true });
  const suites = qualificationPlan(outputDir).map((suite) =>
    runSuite(suite, outputDir),
  );
  const campaign = nativeCampaignReport(outputDir);
  const bundle = createLogBundle(outputDir);
  const report = evaluateQualification({
    source: sourceFacts(),
    platform: {
      os: process.platform,
      arch: process.arch,
      release: os.release(),
    },
    suites,
    campaign,
    bundle,
  });
  writeJson(path.join(outputDir, 'report.json'), report);
  if (args.retain) {
    const retainDir = path.resolve(ROOT, args.retain);
    retainQualificationArtifacts(outputDir, retainDir);
    console.log(`[live-peer-continuity] retained=${retainDir}`);
  }
  console.log(
    `[live-peer-continuity] verdict=${report.verdict} report=${path.join(outputDir, 'report.json')}`,
  );
  if (report.verdict !== 'passed') process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || String(error));
    process.exit(1);
  });
}
