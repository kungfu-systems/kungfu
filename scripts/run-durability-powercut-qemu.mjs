// SPDX-License-Identifier: Apache-2.0
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createPowerCutPlan } from '../framework/core/tests/qualification/durability/powercut_plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIRMATION = 'disposable-powercut-v1';
const WORKSPACE_SENTINEL = 'kungfu.durability.qemu-workspace/v1\n';

export function parseOptions(args) {
  const result = { execute: false };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--execute') {
      result.execute = true;
      continue;
    }
    if (!key?.startsWith('--') || args[index + 1] === undefined) {
      throw new Error(`expected --key value, received '${key || ''}'`);
    }
    result[key.slice(2)] = args[index + 1];
    index += 1;
  }
  return result;
}

export function command(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${argv.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`,
    );
  }
  return (result.stdout || '').trim();
}

export function requireBelow(candidate, root, label) {
  const normalized = path.resolve(candidate);
  if (normalized === root || !normalized.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} must be below ${root}`);
  }
  return normalized;
}

export function dataDriveArgument({
  data,
  dataFormat = 'raw',
  cacheMode = 'none',
  aioMode = cacheMode === 'none' ? 'native' : 'threads',
}) {
  return `if=virtio,format=${dataFormat},cache=${cacheMode},aio=${aioMode},file=${data}`;
}

export function qemuArgs({
  workspace,
  rootfs,
  data,
  kernelArgs,
  dataFormat = 'raw',
  cacheMode = 'none',
  aioMode,
  kernelRelease = '6.8.0-134-generic',
}) {
  return [
    '-enable-kvm',
    '-cpu',
    'host',
    '-m',
    '2048',
    '-smp',
    '2',
    '-nographic',
    '-no-reboot',
    '-nic',
    'none',
    '-kernel',
    `${workspace}/kernel/boot/vmlinuz-${kernelRelease}`,
    '-initrd',
    `${workspace}/initrd.img`,
    '-append',
    kernelArgs,
    '-drive',
    `if=virtio,format=qcow2,file=${rootfs}`,
    '-drive',
    dataDriveArgument({
      data,
      dataFormat,
      cacheMode,
      aioMode,
    }),
  ];
}

export function childFacts(child, data) {
  if (!child.pid) throw new Error('QEMU child has no pid');
  const executable = fs.readlinkSync(`/proc/${child.pid}/exe`);
  const commandLine = fs
    .readFileSync(`/proc/${child.pid}/cmdline`, 'utf8')
    .split('\0')
    .filter(Boolean);
  if (!executable.endsWith('/qemu-system-x86_64')) {
    throw new Error(`refusing non-QEMU child: ${executable}`);
  }
  if (!commandLine.some((item) => item.includes(`file=${data}`))) {
    throw new Error('QEMU child is not bound to the expected data image');
  }
  return { pid: child.pid, executable, command_line: commandLine };
}

export async function waitForLog(child, pathname, markers, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const output = fs.existsSync(pathname)
      ? fs.readFileSync(pathname, 'utf8')
      : '';
    if (markers.every((marker) => output.includes(marker))) return output;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `QEMU exited before markers (${markers.join(', ')}): code=${child.exitCode} signal=${child.signalCode}`,
      );
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for markers: ${markers.join(', ')}`);
}

export async function waitForExit(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return Promise.race([
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs).then(() => {
      throw new Error(`QEMU did not exit within ${timeoutMs}ms`);
    }),
  ]);
}

export function startQemu(args, logPath) {
  const descriptor = fs.openSync(logPath, 'wx');
  const child = spawn('qemu-system-x86_64', args, {
    cwd: ROOT,
    stdio: ['ignore', descriptor, descriptor],
  });
  fs.closeSync(descriptor);
  return child;
}

export async function sha256(pathname) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(pathname)) hash.update(chunk);
  return hash.digest('hex');
}

async function stopChild(child, signal = 'SIGKILL') {
  if (
    child &&
    child.exitCode === null &&
    child.signalCode === null &&
    child.pid
  ) {
    child.kill(signal);
    try {
      await waitForExit(child);
    } catch {
      // The runner already preserves the original trial failure. A direct
      // child that ignores the terminal signal is still not detached.
    }
  }
}

export async function executeTrial({ trial, workspace, rootfsBase }) {
  const dataFormat = trial.data_format || 'raw';
  const cacheMode = trial.cache_mode || 'none';
  const aioMode =
    trial.aio_mode || (cacheMode === 'none' ? 'native' : 'threads');
  const writeRootfs = `${workspace}/${trial.id}-write-rootfs.qcow2`;
  const verifyRootfs = `${workspace}/${trial.id}-verify-rootfs.qcow2`;
  const data = `${workspace}/${trial.id}-data.${dataFormat === 'raw' ? 'ext4' : 'qcow2'}`;
  const writeLog = `${workspace}/evidence/${trial.id}.write.serial.log`;
  const verifyLog = `${workspace}/evidence/${trial.id}.verify.serial.log`;
  const pidFile = `${workspace}/evidence/${trial.id}.qemu.pid`;
  for (const file of [
    writeRootfs,
    verifyRootfs,
    data,
    writeLog,
    verifyLog,
    pidFile,
  ]) {
    if (fs.existsSync(file))
      throw new Error(`refusing existing trial file: ${file}`);
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
    writeRootfs,
  ]);
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
    verifyRootfs,
  ]);
  if (dataFormat === 'raw') {
    command(['cp', '--sparse=always', `${workspace}/data-base.ext4`, data]);
  } else if (dataFormat === 'qcow2') {
    command([
      'qemu-img',
      'create',
      '-q',
      '-f',
      'qcow2',
      '-F',
      'raw',
      '-b',
      `${workspace}/data-base.ext4`,
      data,
    ]);
  } else {
    throw new Error(`unsupported data format: ${dataFormat}`);
  }

  let write;
  let verify;
  try {
    write = startQemu(
      qemuArgs({
        workspace,
        rootfs: writeRootfs,
        data,
        dataFormat,
        cacheMode,
        aioMode,
        kernelRelease: trial.kernel_release,
        kernelArgs: `root=/dev/vda rw rootwait console=ttyS0 panic=-1 init=/opt/kungfu/powercut_guest_init kf_mode=write kf_profile=${trial.profile} kf_fault=${trial.fault}`,
      }),
      writeLog,
    );
    fs.writeFileSync(pidFile, `${write.pid}\n`, { flag: 'wx' });
    await waitForLog(write, writeLog, [trial.arm_marker], 180_000);
    const writeChild = childFacts(write, data);
    write.kill('SIGKILL');
    const writeExit = await waitForExit(write);
    if (writeExit.signal !== 'SIGKILL') {
      throw new Error(
        `write QEMU exit was not SIGKILL: ${JSON.stringify(writeExit)}`,
      );
    }

    verify = startQemu(
      qemuArgs({
        workspace,
        rootfs: verifyRootfs,
        data,
        dataFormat,
        cacheMode,
        aioMode,
        kernelRelease: trial.kernel_release,
        kernelArgs: `root=/dev/vda rw rootwait console=ttyS0 panic=-1 init=/opt/kungfu/powercut_guest_init kf_mode=verify kf_min=${trial.expected_durable_sequence.minimum} kf_max=${trial.expected_durable_sequence.maximum}`,
      }),
      verifyLog,
    );
    const verifyMarkers = [
      '"schema":"kungfu.durability.powercut-verification/v1"',
      '"passed":true',
      'KF_GUEST_EXIT mode=verify status=0',
    ];
    const verifyOutput = await waitForLog(
      verify,
      verifyLog,
      verifyMarkers,
      180_000,
    );
    const verifyChild = childFacts(verify, data);
    verify.kill('SIGTERM');
    let verifyExit;
    try {
      verifyExit = await waitForExit(verify);
    } catch {
      verify.kill('SIGKILL');
      verifyExit = await waitForExit(verify);
    }

    const verificationLine = verifyOutput
      .split(/\r?\n/u)
      .find((line) =>
        line.includes('kungfu.durability.powercut-verification/v1'),
      );
    if (!verificationLine) throw new Error('verification JSON line missing');
    const start = verificationLine.indexOf('{');
    const end = verificationLine.lastIndexOf('}');
    const verification = JSON.parse(verificationLine.slice(start, end + 1));

    return {
      id: trial.id,
      profile: trial.profile,
      fault: trial.fault,
      seed: trial.seed ?? null,
      data_format: dataFormat,
      cache_mode: cacheMode,
      aio_mode: aioMode,
      status: 'passed',
      expected_durable_sequence: trial.expected_durable_sequence,
      verification,
      write_child: writeChild,
      write_exit: writeExit,
      verify_child: verifyChild,
      verify_exit: verifyExit,
      evidence: {
        write_log: path.relative(workspace, writeLog),
        write_log_sha256: await sha256(writeLog),
        verify_log: path.relative(workspace, verifyLog),
        verify_log_sha256: await sha256(verifyLog),
        data_image: path.relative(workspace, data),
        data_image_sha256: await sha256(data),
      },
    };
  } finally {
    await stopChild(write);
    await stopChild(verify);
  }
}

async function main() {
  const parsed = parseOptions(
    process.argv.slice(2).filter((argument) => argument !== '--'),
  );
  const sourceRevision = command(['git', 'rev-parse', 'HEAD']);
  const plan = createPowerCutPlan({
    runId: parsed['run-id'],
    repo: parsed.repo,
    sourceRevision,
    image: parsed.image,
    kernelRelease: parsed['kernel-release'],
    kernelVersion: parsed['kernel-version'],
  });
  const workspace = plan.target.workspace;
  const report = requireBelow(parsed.report, workspace, 'report');
  const rootfsBase = requireBelow(
    parsed['rootfs-base'],
    workspace,
    'rootfs base',
  );
  const only = parsed.only
    ? new Set(String(parsed.only).split(',').filter(Boolean))
    : null;
  const trials = only
    ? plan.trials.filter((trial) => only.has(trial.id))
    : plan.trials;
  if (trials.length === 0 || (only && trials.length !== only.size)) {
    throw new Error('selected trial name is unknown');
  }

  const dryRun = {
    schema: 'kungfu.durability.powercut-qemu-execution-plan/v1',
    mode: parsed.execute ? 'execute' : 'dry-run',
    source_revision: sourceRevision,
    workspace,
    rootfs_base: rootfsBase,
    report,
    trials: trials.map((trial) => trial.id),
    github_workflow: false,
    physical_device_write: false,
    physical_host_restart: false,
  };
  if (!parsed.execute) {
    process.stdout.write(`${JSON.stringify(dryRun, null, 2)}\n`);
    return;
  }

  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('QEMU execution requires the approved Linux x64 host');
  }
  if (process.env.KUNGFU_DURABILITY_QEMU_CONFIRMATION !== CONFIRMATION) {
    throw new Error(
      `KUNGFU_DURABILITY_QEMU_CONFIRMATION=${CONFIRMATION} is required`,
    );
  }
  if (
    fs.readFileSync(
      `${workspace}/.kungfu-disposable-qemu-workspace`,
      'utf8',
    ) !== WORKSPACE_SENTINEL
  ) {
    throw new Error('disposable QEMU workspace sentinel is absent or invalid');
  }
  if (fs.existsSync(report))
    throw new Error(`refusing existing report: ${report}`);
  if (!fs.existsSync(rootfsBase))
    throw new Error(`rootfs base missing: ${rootfsBase}`);
  if (command(['git', 'status', '--porcelain']) !== '') {
    throw new Error('source worktree must be clean');
  }
  if (command(['git', 'rev-parse', 'HEAD']) !== plan.target.source_revision) {
    throw new Error('source revision changed after planning');
  }

  const results = [];
  for (const trial of trials) {
    console.log(`[durability-powercut-qemu] running ${trial.id}`);
    results.push(await executeTrial({ trial, workspace, rootfsBase }));
    console.log(`[durability-powercut-qemu] passed ${trial.id}`);
  }
  const completeMatrix = results.length === plan.trials.length;
  const output = {
    schema: 'kungfu.durability.powercut-qemu-report/v1',
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
      disposable_vm_power_cut_qualified: completeMatrix,
      physical_power_loss_qualified: false,
      production_profile_eligible: false,
    },
    results,
  };
  fs.writeFileSync(report, `${JSON.stringify(output, null, 2)}\n`, {
    flag: 'wx',
  });
  console.log(`[durability-powercut-qemu] report=${report}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main();
  } catch (error) {
    console.error(
      `[durability-powercut-qemu] ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
    process.exit(1);
  }
}
