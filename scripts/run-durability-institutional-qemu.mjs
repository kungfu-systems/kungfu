// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  childFacts,
  command,
  parseOptions,
  qemuArgs,
  requireBelow,
  sha256,
  startQemu,
  waitForExit,
  waitForLog,
} from './run-durability-powercut-qemu.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIRMATION = 'disposable-powercut-v1';
const WORKSPACE_SENTINEL = 'kungfu.durability.qemu-workspace/v1\n';
const BACKUP_SENTINEL = 'kungfu.durability.disposable-backup-root/v1\n';

function requireFileContent(pathname, expected, label) {
  if (fs.readFileSync(pathname, 'utf8') !== expected) {
    throw new Error(`${label} sentinel is absent or invalid`);
  }
}

async function stopQemu(child) {
  child.kill('SIGTERM');
  try {
    return await waitForExit(child);
  } catch {
    child.kill('SIGKILL');
    return waitForExit(child);
  }
}

async function boot({ workspace, rootfsBase, data, id, kernelArgs, markers }) {
  const rootfs = `${workspace}/${id}-rootfs.qcow2`;
  const serialLog = `${workspace}/evidence/${id}.serial.log`;
  if (fs.existsSync(rootfs) || fs.existsSync(serialLog)) {
    throw new Error(`refusing existing boot evidence for ${id}`);
  }
  command([
    'qemu-img',
    'create',
    '-q',
    '-f',
    'qcow2',
    '-F',
    'raw',
    '-b',
    rootfsBase,
    rootfs,
  ]);
  const child = startQemu(
    qemuArgs({ workspace, rootfs, data, kernelArgs }),
    serialLog,
  );
  const output = await waitForLog(child, serialLog, markers, 180_000);
  const facts = childFacts(child, data);
  const exit = await stopQemu(child);
  return {
    id,
    child: facts,
    exit,
    serial_log: path.relative(workspace, serialLog),
    serial_log_sha256: await sha256(serialLog),
    output,
  };
}

function verification(output, schema) {
  const line = output
    .split(/\r?\n/u)
    .find((candidate) => candidate.includes(schema));
  if (!line) throw new Error(`${schema} JSON line missing`);
  return JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1));
}

function fsck(pathname) {
  const result = spawnSync('e2fsck', ['-fn', pathname], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(
      `e2fsck -fn ${pathname} failed: ${result.error?.message || result.stderr || result.status}`,
    );
  }
  return {
    command: ['e2fsck', '-fn', pathname],
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

export async function executeInstitutionalTrial({
  workspace,
  rootfsBase,
  backupDir,
}) {
  const data = `${workspace}/institutional-data.ext4`;
  const enospcData = `${workspace}/real-enospc-data.ext4`;
  const backup = `${backupDir}/institutional-data.ext4`;
  const restored = `${workspace}/restored-empty-device.ext4`;
  for (const pathname of [data, enospcData, backup, restored]) {
    if (fs.existsSync(pathname))
      throw new Error(`refusing existing institutional evidence: ${pathname}`);
  }
  command(['cp', '--sparse=always', `${workspace}/data-base.ext4`, data]);
  command(['cp', '--sparse=always', `${workspace}/data-base.ext4`, enospcData]);

  const cleanWrite = await boot({
    workspace,
    rootfsBase,
    data,
    id: 'clean-write',
    kernelArgs:
      'root=/dev/vda rw rootwait console=ttyS0 panic=-1 init=/opt/kungfu/powercut_guest_init kf_mode=write kf_profile=durable_sync kf_fault=none',
    markers: [
      'KF_DURABLE_RECEIPT profile=durable_sync sequence=1',
      'KF_DATA_UNMOUNTED mode=write',
      'KF_GUEST_EXIT mode=write status=0',
    ],
  });

  const recoveryBoots = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const recovered = await boot({
      workspace,
      rootfsBase,
      data,
      id: `recovery-${attempt}`,
      kernelArgs:
        'root=/dev/vda rw rootwait console=ttyS0 panic=-1 init=/opt/kungfu/powercut_guest_init kf_mode=verify kf_min=1 kf_max=1',
      markers: [
        '"schema":"kungfu.durability.powercut-verification/v1"',
        '"passed":true',
        'KF_DATA_UNMOUNTED mode=verify',
        'KF_GUEST_EXIT mode=verify status=0',
      ],
    });
    recovered.verification = verification(
      recovered.output,
      'kungfu.durability.powercut-verification/v1',
    );
    recovered.output = undefined;
    recoveryBoots.push(recovered);
  }

  const beforeBackupFsck = fsck(data);
  fs.copyFileSync(data, backup, fs.constants.COPYFILE_EXCL);
  const backupSha256 = await sha256(backup);
  fs.copyFileSync(backup, restored, fs.constants.COPYFILE_EXCL);
  const restoredSha256 = await sha256(restored);
  if (backupSha256 !== restoredSha256) {
    throw new Error('restored data image hash differs from offline backup');
  }
  const afterRestoreFsck = fsck(restored);
  const restoreBoot = await boot({
    workspace,
    rootfsBase,
    data: restored,
    id: 'backup-restore',
    kernelArgs:
      'root=/dev/vda rw rootwait console=ttyS0 panic=-1 init=/opt/kungfu/powercut_guest_init kf_mode=verify kf_min=1 kf_max=1',
    markers: [
      '"schema":"kungfu.durability.powercut-verification/v1"',
      '"passed":true',
      'KF_DATA_UNMOUNTED mode=verify',
      'KF_GUEST_EXIT mode=verify status=0',
    ],
  });
  restoreBoot.verification = verification(
    restoreBoot.output,
    'kungfu.durability.powercut-verification/v1',
  );
  restoreBoot.output = undefined;

  const enospc = await boot({
    workspace,
    rootfsBase,
    data: enospcData,
    id: 'real-enospc',
    kernelArgs:
      'root=/dev/vda rw rootwait console=ttyS0 panic=-1 init=/opt/kungfu/powercut_guest_init kf_mode=enospc kf_profile=durable_sync',
    markers: [
      '"schema":"kungfu.durability.real-enospc-verification/v1"',
      '"passed":true',
      'KF_DATA_UNMOUNTED mode=enospc',
      'KF_GUEST_EXIT mode=enospc status=0',
    ],
  });
  enospc.verification = verification(
    enospc.output,
    'kungfu.durability.real-enospc-verification/v1',
  );
  enospc.output = undefined;
  const enospcReopen = await boot({
    workspace,
    rootfsBase,
    data: enospcData,
    id: 'real-enospc-reopen',
    kernelArgs:
      'root=/dev/vda rw rootwait console=ttyS0 panic=-1 init=/opt/kungfu/powercut_guest_init kf_mode=verify kf_min=0 kf_max=0',
    markers: [
      '"schema":"kungfu.durability.powercut-verification/v1"',
      '"passed":true',
      'KF_DATA_UNMOUNTED mode=verify',
      'KF_GUEST_EXIT mode=verify status=0',
    ],
  });
  enospcReopen.verification = verification(
    enospcReopen.output,
    'kungfu.durability.powercut-verification/v1',
  );
  enospcReopen.output = undefined;

  cleanWrite.output = undefined;
  return {
    clean_write_and_unmount: cleanWrite,
    repeated_whole_guest_recovery: recoveryBoots,
    backup_restore: {
      backup_cut: 'quiesced_after_durable_sequence_1_and_clean_unmount',
      maximum_observed_rpo_records: 0,
      external_backup_path: backup,
      backup_sha256: backupSha256,
      restored_empty_device: path.relative(workspace, restored),
      restored_sha256: restoredSha256,
      before_backup_fsck: beforeBackupFsck,
      after_restore_fsck: afterRestoreFsck,
      restore_boot: restoreBoot,
    },
    real_enospc: enospc,
    real_enospc_reopen: enospcReopen,
  };
}

async function main() {
  const parsed = parseOptions(
    process.argv.slice(2).filter((argument) => argument !== '--'),
  );
  const workspace = path.resolve(parsed.workspace);
  const report = requireBelow(parsed.report, workspace, 'report');
  const rootfsBase = requireBelow(
    parsed['rootfs-base'],
    workspace,
    'rootfs base',
  );
  const backupRoot = '/data/qualification/kungfu/backups';
  const backupDir = requireBelow(
    parsed['backup-dir'],
    backupRoot,
    'backup dir',
  );
  const sourceRevision = command(['git', 'rev-parse', 'HEAD']);
  const dryRun = {
    schema: 'kungfu.durability.institutional-qemu-execution-plan/v1',
    mode: parsed.execute ? 'execute' : 'dry-run',
    source_revision: sourceRevision,
    workspace,
    rootfs_base: rootfsBase,
    backup_dir: backupDir,
    report,
    github_workflow: false,
    physical_device_write: false,
    physical_host_restart: false,
  };
  if (!parsed.execute) {
    process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`);
    return;
  }
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('institutional QEMU execution requires Linux x64');
  }
  if (process.env.KUNGFU_DURABILITY_QEMU_CONFIRMATION !== CONFIRMATION) {
    throw new Error(
      `KUNGFU_DURABILITY_QEMU_CONFIRMATION=${CONFIRMATION} is required`,
    );
  }
  requireFileContent(
    `${workspace}/.kungfu-disposable-qemu-workspace`,
    WORKSPACE_SENTINEL,
    'workspace',
  );
  requireFileContent(
    `${backupDir}/.kungfu-disposable-backup-root`,
    BACKUP_SENTINEL,
    'backup root',
  );
  if (fs.existsSync(report))
    throw new Error(`refusing existing report: ${report}`);
  if (!fs.existsSync(rootfsBase))
    throw new Error(`rootfs base missing: ${rootfsBase}`);
  if (command(['git', 'status', '--porcelain']) !== '') {
    throw new Error('source worktree must be clean');
  }

  const results = await executeInstitutionalTrial({
    workspace,
    rootfsBase,
    backupDir,
  });
  const output = {
    schema: 'kungfu.durability.single-host-institutional-qemu-report/v1',
    verdict: 'passed',
    source: {
      revision: sourceRevision,
      tree: command(['git', 'rev-parse', 'HEAD^{tree}']),
      dirty: false,
    },
    host: {
      hostname: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      qemu: command(['qemu-system-x86_64', '--version']).split('\n')[0],
      workspace_filesystem: command(['stat', '-f', '-c', '%T', workspace]),
    },
    execution: dryRun,
    claims: {
      real_enospc_no_false_ack_qualified: true,
      clean_unmount_whole_guest_reopen_qualified: true,
      repeated_whole_guest_recovery_qualified: true,
      offline_external_path_backup_restore_qualified: true,
      physical_host_restart_qualified: false,
      off_host_backup_qualified: false,
      independent_backup_failure_domain_qualified: false,
      production_profile_eligible: false,
    },
    results,
  };
  fs.writeFileSync(report, `${JSON.stringify(output, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(`[durability-institutional-qemu] report=${report}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[durability-institutional-qemu] ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
    process.exit(1);
  }
}
