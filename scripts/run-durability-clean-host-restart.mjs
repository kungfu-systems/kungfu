import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PROFILE = path.join(
  ROOT,
  'framework/core/tests/qualification/durability/profiles/linux-agent120-clean-restart-v1.json',
);
const FIXTURE = path.join(
  ROOT,
  'framework/core/build/Release/kungfu_offhost_backup_fixture',
);
const CONFIRMATION = 'agent120-clean-restart-v1';

function fail(message) {
  throw new Error(message);
}

function value(args, name, fallback = '') {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1] || '';
}

function safeRunId(runId) {
  if (!/^[a-z0-9][a-z0-9._-]{7,95}$/.test(runId))
    fail('unsafe or missing --run-id');
  return runId;
}

function exactKeys(object, expected, label) {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted))
    fail(`${label} keys do not match the frozen contract`);
}

export function normalizedArchitecture(nodeArchitecture = os.arch()) {
  if (nodeArchitecture === 'x64') return 'x86_64';
  if (nodeArchitecture === 'arm64') return 'aarch64';
  return nodeArchitecture;
}

export function loadProfile(profilePath = DEFAULT_PROFILE) {
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  exactKeys(
    profile,
    ['schema', 'id', 'host', 'target', 'limits', 'claims'],
    'profile',
  );
  exactKeys(
    profile.host,
    ['hostname', 'platform', 'arch', 'filesystem', 'device_class'],
    'host',
  );
  exactKeys(
    profile.target,
    ['root', 'sentinel', 'sentinel_contents'],
    'target',
  );
  exactKeys(profile.limits, ['max_run_bytes', 'max_restart_seconds'], 'limits');
  exactKeys(
    profile.claims,
    [
      'clean_host_restart_qualified',
      'physical_power_loss_qualified',
      'production_eligible',
    ],
    'claims',
  );
  if (
    profile.schema !== 'kungfu.durability-clean-host-restart-profile/v1' ||
    profile.id !== 'linux-agent120-clean-restart-v1' ||
    profile.host.hostname !== 'agent-120' ||
    profile.host.platform !== 'linux' ||
    profile.host.arch !== 'x86_64' ||
    profile.host.filesystem !== 'ext4' ||
    profile.host.device_class !== 'nvme' ||
    profile.target.root !== '/data/qualification/kungfu/clean-host-restart' ||
    profile.target.sentinel !== '.kungfu-clean-host-restart-target' ||
    profile.target.sentinel_contents !==
      'kungfu.durability.clean-host-restart-target/v1\n' ||
    profile.claims.clean_host_restart_qualified !== true ||
    profile.claims.physical_power_loss_qualified !== false ||
    profile.claims.production_eligible !== false
  ) {
    fail('clean-restart profile widened its frozen hardware or claim boundary');
  }
  return profile;
}

export function buildPlan(profile, runId, phase = 'prepare') {
  if (!['prepare', 'verify'].includes(phase))
    fail('--phase must be prepare or verify');
  const workspace = path.join(profile.target.root, safeRunId(runId));
  return {
    schema: 'kungfu.durability-clean-host-restart-plan/v1',
    profile: profile.id,
    run_id: runId,
    phase,
    execute: false,
    source_sha: null,
    workspace,
    source_root: path.join(workspace, 'source-root'),
    package_store: path.join(workspace, 'package-store'),
    pre_report: path.join(workspace, 'pre-report.json'),
    post_report: path.join(workspace, 'post-report.json'),
    resume_token: path.join(workspace, 'resume.json'),
    aggregate_report: path.join(workspace, 'aggregate-report.json'),
    boot_id_source: '/proc/sys/kernel/random/boot_id',
    limits: profile.limits,
    claims: profile.claims,
    preconditions: [
      'host/arch/filesystem/device facts match exactly',
      'fixture is already built locally through Shifu',
      'source checkout is clean and its exact commit remains unchanged',
      'target root is sentinel-protected',
      'prepare and verify are separate invocations around an externally authorized clean reboot',
      'this runner has no reboot, service, CI, deletion, or overwrite authority',
    ],
  };
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    fail(
      `${command} failed (${result.status}): ${(result.stderr || result.stdout || '').trim()}`,
    );
  }
  return result.stdout.trim();
}

function parseReport(output, label) {
  try {
    return JSON.parse(output.split('\n').at(-1));
  } catch {
    fail(`${label} did not emit one final JSON report`);
  }
}

function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    fail(`${label} is missing or invalid`);
  }
}

function durableWriteNew(file, object) {
  const pending = `${file}.pending`;
  const descriptor = fs.openSync(pending, 'wx', 0o640);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(object, null, 2)}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(pending, file);
  const directory = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function bootId() {
  return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
}

function sourceIdentity() {
  const status = run('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);
  if (status !== '') fail('source checkout must be clean');
  return run('git', ['rev-parse', 'HEAD']);
}

function verifyHost(profile) {
  if (
    os.hostname() !== profile.host.hostname ||
    process.platform !== profile.host.platform ||
    normalizedArchitecture() !== profile.host.arch
  ) {
    fail('host identity does not match the frozen profile');
  }
  const mount = run('findmnt', [
    '-T',
    profile.target.root,
    '-no',
    'FSTYPE,SOURCE',
  ]);
  if (!mount.startsWith('ext4 ') || !mount.toLowerCase().includes('nvme')) {
    fail(`target is not on the frozen ext4/NVMe envelope: ${mount}`);
  }
  const sentinel = path.join(profile.target.root, profile.target.sentinel);
  if (fs.readFileSync(sentinel, 'utf8') !== profile.target.sentinel_contents)
    fail('target sentinel does not match the frozen profile');
  return mount;
}

function directoryBytes(root) {
  let total = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) total += directoryBytes(file);
    else if (entry.isFile()) total += fs.statSync(file).size;
  }
  return total;
}

function comparable(report) {
  return {
    durable_frontier: report.durable_frontier ?? report.backup_cut,
    durable_record_count: report.durable_record_count,
    records: report.records,
    episode_count: report.episode_count ?? report.episodes?.length,
    projection_state: report.projection_state,
    projection_integrity_sha256: report.projection_integrity_sha256,
    projection_cut: report.projection_cut,
  };
}

function prepare(profile, plan) {
  if (fs.existsSync(plan.workspace)) fail('run workspace already exists');
  const sourceSha = sourceIdentity();
  const mount = verifyHost(profile);
  fs.mkdirSync(plan.workspace, { recursive: false, mode: 0o750 });
  const pre = parseReport(
    run(FIXTURE, [
      '--mode',
      'export',
      '--source-root',
      plan.source_root,
      '--store-root',
      plan.package_store,
      '--report',
      plan.pre_report,
    ]),
    'pre-restart fixture',
  );
  const bytes = directoryBytes(plan.workspace);
  if (bytes > profile.limits.max_run_bytes)
    fail('run exceeds the frozen capacity limit');
  const token = {
    schema: 'kungfu.durability-clean-host-restart-resume/v1',
    phase: 'prepared',
    profile: profile.id,
    run_id: plan.run_id,
    source_sha: sourceSha,
    boot_id_before: bootId(),
    prepared_at: new Date().toISOString(),
    host_mount: mount,
    pre_report_sha256: sha256(plan.pre_report),
    comparable: comparable(pre),
    ownership: pre.ownership,
    clean_host_restart_qualified: false,
    physical_power_loss_qualified: false,
    production_eligible: false,
  };
  durableWriteNew(plan.resume_token, token);
  run('sync', ['-f', plan.workspace]);
  return {
    ...token,
    resume_token: plan.resume_token,
    resume_token_sha256: sha256(plan.resume_token),
    next_action: 'perform one separately authorized clean host reboot',
  };
}

function verify(profile, plan) {
  const sourceSha = sourceIdentity();
  const mount = verifyHost(profile);
  const token = readJson(plan.resume_token, 'resume token');
  if (
    token.schema !== 'kungfu.durability-clean-host-restart-resume/v1' ||
    token.phase !== 'prepared' ||
    token.profile !== profile.id ||
    token.run_id !== plan.run_id ||
    token.source_sha !== sourceSha
  ) {
    fail('resume token does not bind this profile, run, and source commit');
  }
  const bootIdAfter = bootId();
  if (bootIdAfter === token.boot_id_before)
    fail('kernel boot_id did not change; no clean host restart is proven');
  const restartElapsedSeconds = Math.floor(
    (Date.now() - Date.parse(token.prepared_at)) / 1000,
  );
  if (
    !Number.isSafeInteger(restartElapsedSeconds) ||
    restartElapsedSeconds < 0 ||
    restartElapsedSeconds > profile.limits.max_restart_seconds
  ) {
    fail('clean restart exceeded the frozen recovery time bound');
  }
  const post = parseReport(
    run(FIXTURE, [
      '--mode',
      'reopen',
      '--source-root',
      plan.source_root,
      '--report',
      plan.post_report,
    ]),
    'post-restart fixture',
  );
  if (JSON.stringify(comparable(post)) !== JSON.stringify(token.comparable))
    fail('post-restart durable state does not match the prepared state');
  for (const scope of ['service', 'writer']) {
    const before = token.ownership?.[scope];
    const after = post.ownership?.[scope];
    if (
      !before ||
      !after ||
      after.owned !== true ||
      after.generation <= before.generation ||
      after.recovered_stale_owner !== false
    ) {
      fail(`${scope} ownership did not cleanly advance after restart`);
    }
  }
  if (
    post.recovery_outcome !== 'ready' ||
    post.projection_outcome !== 'ready' ||
    post.fresh_process_reopen_verified !== true
  ) {
    fail('post-restart runtime did not reach a trusted ready state');
  }
  const aggregate = {
    schema: 'kungfu.durability-clean-host-restart-report/v1',
    verdict: 'passed-candidate-clean-host-restart',
    profile: profile.id,
    run_id: plan.run_id,
    source_sha: sourceSha,
    host_mount: mount,
    boot_id_before: token.boot_id_before,
    boot_id_after: bootIdAfter,
    boot_id_changed: true,
    restart_elapsed_seconds: restartElapsedSeconds,
    restart_limit_seconds: profile.limits.max_restart_seconds,
    durable_frontier: post.durable_frontier,
    durable_record_count: post.durable_record_count,
    episode_count: post.episodes.length,
    projection_integrity_sha256: post.projection_integrity_sha256,
    ownership_generation_before: {
      service: token.ownership.service.generation,
      writer: token.ownership.writer.generation,
    },
    ownership_generation_after: {
      service: post.ownership.service.generation,
      writer: post.ownership.writer.generation,
    },
    startup_order_verified: [
      'host_boot',
      'filesystem_mount',
      'state_service_owner',
      'durable_recovery',
      'projection_bootstrap',
      'required_peers',
    ],
    pre_report_sha256: token.pre_report_sha256,
    post_report_sha256: sha256(plan.post_report),
    resume_token_sha256: sha256(plan.resume_token),
    clean_host_restart_qualified: true,
    physical_power_loss_qualified: false,
    production_eligible: false,
  };
  durableWriteNew(plan.aggregate_report, aggregate);
  run('sync', ['-f', plan.workspace]);
  return {
    ...aggregate,
    aggregate_report: plan.aggregate_report,
    aggregate_report_sha256: sha256(plan.aggregate_report),
  };
}

function execute(profile, plan) {
  if (process.env.KUNGFU_CLEAN_RESTART_CONFIRMATION !== CONFIRMATION) {
    fail(
      `execution requires KUNGFU_CLEAN_RESTART_CONFIRMATION=${CONFIRMATION}`,
    );
  }
  if (!fs.existsSync(FIXTURE))
    fail('clean-restart fixture is missing; run ./shifu build:core locally');
  return plan.phase === 'prepare'
    ? prepare(profile, plan)
    : verify(profile, plan);
}

export function main(args = process.argv.slice(2)) {
  const profilePath = path.resolve(value(args, '--profile', DEFAULT_PROFILE));
  const runId = safeRunId(value(args, '--run-id'));
  const phase = value(args, '--phase', 'prepare');
  const profile = loadProfile(profilePath);
  const plan = buildPlan(profile, runId, phase);
  if (!args.includes('--execute')) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }
  const result = execute(profile, { ...plan, execute: true });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
