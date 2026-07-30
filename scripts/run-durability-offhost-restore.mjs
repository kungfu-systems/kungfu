import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PROFILE = path.join(
  ROOT,
  'framework/core/tests/qualification/durability/profiles/linux-agent120-ubuntu222-offhost-v1.json',
);
const FIXTURE = path.join(
  ROOT,
  'framework/core/build/Release/kungfu_offhost_backup_fixture',
);
const CONFIRMATION = 'agent120-ubuntu222-v1';

function fail(message) {
  throw new Error(message);
}

function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
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

function shellQuote(input) {
  return `'${String(input).replaceAll("'", `'"'"'`)}'`;
}

export function normalizedArchitecture(nodeArchitecture = os.arch()) {
  if (nodeArchitecture === 'x64') return 'x86_64';
  if (nodeArchitecture === 'arm64') return 'aarch64';
  return nodeArchitecture;
}

function exactKeys(object, expected, label) {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted))
    fail(`${label} keys do not match the frozen contract`);
}

export function loadProfile(profilePath = DEFAULT_PROFILE) {
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  exactKeys(
    profile,
    ['schema', 'id', 'source', 'target', 'transport', 'limits', 'claims'],
    'profile',
  );
  exactKeys(
    profile.source,
    ['hostname', 'platform', 'arch', 'filesystem', 'device_class'],
    'source',
  );
  exactKeys(
    profile.target,
    [
      'ssh',
      'hostname',
      'root',
      'sentinel',
      'sentinel_contents',
      'filesystem',
      'device_class',
      'same_office',
    ],
    'target',
  );
  exactKeys(
    profile.transport,
    [
      'tool',
      'bwlimit_kib_per_second',
      'delete_allowed',
      'partial_directory_retained',
    ],
    'transport',
  );
  exactKeys(
    profile.limits,
    ['max_package_bytes', 'max_restore_bytes'],
    'limits',
  );
  exactKeys(
    profile.claims,
    [
      'off_host_verified',
      'independent_failure_domain_qualified',
      'physical_power_loss_qualified',
      'production_eligible',
    ],
    'claims',
  );
  if (
    profile.schema !== 'kungfu.durability-offhost-profile/v1' ||
    profile.id !== 'linux-agent120-ubuntu222-offhost-v1' ||
    profile.source.hostname !== 'agent-120' ||
    profile.source.platform !== 'linux' ||
    profile.source.arch !== 'x86_64' ||
    profile.source.filesystem !== 'ext4' ||
    profile.source.device_class !== 'nvme' ||
    profile.target.ssh !== '192.168.100.222' ||
    profile.target.hostname !== 'Kerens-MoreFine' ||
    profile.target.root !==
      '/data/qualification/kungfu/offhost-backup-restore' ||
    !profile.target.sentinel.startsWith('.') ||
    profile.target.sentinel_contents !==
      'kungfu.durability.offhost-backup-target/v1\n' ||
    profile.target.filesystem !== 'ext4' ||
    profile.target.device_class !== 'nvme' ||
    profile.target.same_office !== true ||
    profile.transport.tool !== 'rsync' ||
    profile.transport.delete_allowed !== false ||
    profile.transport.partial_directory_retained !== true ||
    profile.claims.off_host_verified !== true ||
    profile.claims.independent_failure_domain_qualified !== false ||
    profile.claims.physical_power_loss_qualified !== false ||
    profile.claims.production_eligible !== false
  ) {
    fail(
      'off-host profile widened its frozen hardware, transport, or claim boundary',
    );
  }
  return profile;
}

export function buildPlan(profile, runId) {
  const workspace = path.join(
    ROOT,
    'framework/core/build/qualification/durability-offhost',
    safeRunId(runId),
  );
  const targetRun = `${profile.target.root}/${runId}`;
  return {
    schema: 'kungfu.durability-offhost-plan/v1',
    profile: profile.id,
    run_id: runId,
    execute: false,
    source: {
      required_hostname: profile.source.hostname,
      workspace,
      fixture: FIXTURE,
      package_store: path.join(workspace, 'package-store'),
      report: path.join(workspace, 'source-report.json'),
    },
    target: {
      ssh: profile.target.ssh,
      required_hostname: profile.target.hostname,
      root: profile.target.root,
      sentinel: `${profile.target.root}/${profile.target.sentinel}`,
      run: targetRun,
      partial_package: `${targetRun}/package.partial`,
      incoming_package: `${targetRun}/package.incoming`,
      completed_package: `${targetRun}/package`,
      restore_root: `${targetRun}/restore-root`,
      verify_report: `${targetRun}/verify-report.json`,
      restore_report: `${targetRun}/restore-report.json`,
    },
    transport: {
      argv_prefix: [
        'rsync',
        '-a',
        '--checksum',
        '--partial',
        `--bwlimit=${profile.transport.bwlimit_kib_per_second}`,
        '--protect-args',
      ],
      delete_allowed: false,
      partial_directory_retained: true,
    },
    limits: profile.limits,
    claims: profile.claims,
    preconditions: [
      'source host/arch/filesystem/device facts match exactly',
      'fixture is already built locally through Shifu',
      'target root is sentinel-protected and the run path does not exist',
      'no rsync delete, overwrite, service, network, NAS, or existing backup path authority',
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

function copyRuntime(runtimeRoot) {
  const bin = path.join(runtimeRoot, 'bin');
  const lib = path.join(runtimeRoot, 'lib');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(lib, { recursive: true });
  const targetFixture = path.join(bin, path.basename(FIXTURE));
  fs.copyFileSync(FIXTURE, targetFixture, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(targetFixture, 0o755);
  const dependencies = run('ldd', [FIXTURE]);
  for (const line of dependencies.split('\n')) {
    const match = line.match(/^\s*(\S+)\s+=>\s+(\/\S+)\s+\(/);
    if (!match) continue;
    const [, soname, source] = match;
    if (!source.startsWith(ROOT) && !source.includes('/.conan2/')) continue;
    fs.copyFileSync(source, path.join(lib, soname), fs.constants.COPYFILE_EXCL);
  }
  return targetFixture;
}

function remoteCommand(runtimeRoot, args) {
  const fixture = `${runtimeRoot}/bin/${path.basename(FIXTURE)}`;
  return `env LD_LIBRARY_PATH=${shellQuote(`${runtimeRoot}/lib`)} ${shellQuote(fixture)} ${args.map(shellQuote).join(' ')}`;
}

function packageBytes(packageRoot) {
  let total = 0;
  for (const entry of fs.readdirSync(packageRoot, { withFileTypes: true })) {
    const entryPath = path.join(packageRoot, entry.name);
    if (entry.isDirectory()) total += packageBytes(entryPath);
    else if (entry.isFile()) total += fs.statSync(entryPath).size;
  }
  return total;
}

function execute(profile, plan) {
  if (process.env.KUNGFU_OFFHOST_RESTORE_CONFIRMATION !== CONFIRMATION) {
    fail(
      `execution requires KUNGFU_OFFHOST_RESTORE_CONFIRMATION=${CONFIRMATION}`,
    );
  }
  if (
    os.hostname() !== profile.source.hostname ||
    normalizedArchitecture() !== profile.source.arch
  ) {
    fail('source host identity does not match the frozen profile');
  }
  if (!fs.existsSync(FIXTURE))
    fail('off-host fixture is missing; run ./shifu build:core locally');
  if (fs.existsSync(plan.source.workspace))
    fail('run workspace already exists');

  const sourceMount = run('findmnt', ['-T', ROOT, '-no', 'FSTYPE,SOURCE']);
  if (
    !sourceMount.startsWith('ext4 ') ||
    !sourceMount.toLowerCase().includes('nvme')
  ) {
    fail(
      `source worktree is not on the frozen ext4/NVMe envelope: ${sourceMount}`,
    );
  }
  const targetFacts = run('ssh', [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    profile.target.ssh,
    `set -eu; test "$(hostname)" = ${shellQuote(profile.target.hostname)}; test "$(findmnt -T ${shellQuote(profile.target.root)} -no FSTYPE)" = ext4; test "$(cat ${shellQuote(`${profile.target.root}/${profile.target.sentinel}`)})" = ${shellQuote(profile.target.sentinel_contents.trim())}; test ! -e ${shellQuote(plan.target.run)}; printf verified`,
  ]);
  if (targetFacts !== 'verified')
    fail('target preconditions were not verified');

  fs.mkdirSync(plan.source.workspace, { recursive: true });
  const runtimeRoot = path.join(plan.source.workspace, 'runtime');
  copyRuntime(runtimeRoot);
  const exportReport = parseReport(
    run(FIXTURE, [
      '--mode',
      'export',
      '--source-root',
      path.join(plan.source.workspace, 'source-root'),
      '--store-root',
      plan.source.package_store,
      '--report',
      plan.source.report,
    ]),
    'source export',
  );
  const packageRoot = exportReport.package_path;
  const bytes = packageBytes(packageRoot);
  if (bytes > profile.limits.max_package_bytes)
    fail('package exceeds frozen capacity limit');

  run('ssh', [
    profile.target.ssh,
    `mkdir -m 0750 ${shellQuote(plan.target.run)}`,
  ]);
  run('rsync', [
    ...plan.transport.argv_prefix.slice(1),
    `${runtimeRoot}/`,
    `${profile.target.ssh}:${plan.target.run}/runtime/`,
  ]);
  run('ssh', [
    profile.target.ssh,
    `mkdir -m 0750 ${shellQuote(plan.target.partial_package)}`,
  ]);
  run('rsync', [
    ...plan.transport.argv_prefix.slice(1),
    `${packageRoot}/manifest.json`,
    `${profile.target.ssh}:${plan.target.partial_package}/manifest.json`,
  ]);
  const partial = childProcess.spawnSync(
    'ssh',
    [
      profile.target.ssh,
      remoteCommand(`${plan.target.run}/runtime`, [
        '--mode',
        'verify',
        '--package',
        plan.target.partial_package,
        '--report',
        `${plan.target.partial_package}/unexpected-report.json`,
      ]),
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  if (
    partial.status === 0 ||
    !partial.stderr.includes('recovery_backup_package_incomplete')
  ) {
    fail('interrupted transfer did not fail closed with the expected reason');
  }

  run('rsync', [
    ...plan.transport.argv_prefix.slice(1),
    `${packageRoot}/`,
    `${profile.target.ssh}:${plan.target.incoming_package}/`,
  ]);
  const verifyReport = parseReport(
    run('ssh', [
      profile.target.ssh,
      remoteCommand(`${plan.target.run}/runtime`, [
        '--mode',
        'verify',
        '--package',
        plan.target.incoming_package,
        '--report',
        plan.target.verify_report,
      ]),
    ]),
    'target verify',
  );
  run('ssh', [
    profile.target.ssh,
    `test ! -e ${shellQuote(plan.target.completed_package)} && mv ${shellQuote(plan.target.incoming_package)} ${shellQuote(plan.target.completed_package)}`,
  ]);
  const restoreReport = parseReport(
    run('ssh', [
      profile.target.ssh,
      remoteCommand(`${plan.target.run}/runtime`, [
        '--mode',
        'restore',
        '--package',
        plan.target.completed_package,
        '--restore-root',
        plan.target.restore_root,
        '--report',
        plan.target.restore_report,
      ]),
    ]),
    'target restore',
  );

  const compare = [
    'bundle_id',
    'manifest_sha256',
    'durable_record_count',
    'projection_integrity_sha256',
  ];
  for (const field of compare) {
    if (exportReport[field] !== restoreReport[field])
      fail(`source/restore ${field} mismatch`);
  }
  if (
    JSON.stringify(exportReport.records) !==
    JSON.stringify(restoreReport.records)
  ) {
    fail('source/restore durable records mismatch');
  }
  if (
    JSON.stringify(exportReport.projection_state) !==
    JSON.stringify(restoreReport.projection_state)
  ) {
    fail('source/restore projection state mismatch');
  }
  if (
    verifyReport.bundle_id !== exportReport.bundle_id ||
    verifyReport.manifest_sha256 !== exportReport.manifest_sha256
  ) {
    fail('target verifier identity mismatch');
  }

  const aggregate = {
    schema: 'kungfu.durability-offhost-report/v1',
    verdict: 'passed-candidate-offhost-restore',
    profile: profile.id,
    run_id: plan.run_id,
    source_hostname: os.hostname(),
    source_mount: sourceMount,
    target_hostname: profile.target.hostname,
    target_root: profile.target.root,
    target_run: plan.target.run,
    bundle_id: exportReport.bundle_id,
    manifest_sha256: exportReport.manifest_sha256,
    package_bytes: bytes,
    backup_cut: exportReport.backup_cut,
    durable_record_count: exportReport.durable_record_count,
    episode_count: exportReport.episode_count,
    projection_integrity_sha256: exportReport.projection_integrity_sha256,
    interrupted_transfer_rejected: true,
    partial_directory_retained: true,
    repeated_restore_idempotent: restoreReport.repeated_restore_idempotent,
    off_host_verified: true,
    same_office: true,
    independent_failure_domain_qualified: false,
    physical_power_loss_qualified: false,
    production_eligible: false,
    source_report_sha256: sha256(plan.source.report),
    target_verify_report: plan.target.verify_report,
    target_restore_report: plan.target.restore_report,
  };
  const report = path.join(plan.source.workspace, 'aggregate-report.json');
  fs.writeFileSync(report, `${JSON.stringify(aggregate, null, 2)}\n`, {
    flag: 'wx',
  });
  return {
    ...aggregate,
    aggregate_report: report,
    aggregate_report_sha256: sha256(report),
  };
}

export function main(args = process.argv.slice(2)) {
  const profilePath = path.resolve(value(args, '--profile', DEFAULT_PROFILE));
  const runId = safeRunId(value(args, '--run-id'));
  const profile = loadProfile(profilePath);
  const plan = buildPlan(profile, runId);
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
