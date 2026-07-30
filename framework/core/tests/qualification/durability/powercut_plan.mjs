// SPDX-License-Identifier: Apache-2.0
// @ts-check

import path from 'node:path';

export const POWER_CUT_FAULTS = [
  ['before_record_write', 0, 0],
  ['after_record_write', 0, 0],
  ['before_data_sync', 0, 0],
  ['after_data_sync', 0, 0],
  ['before_checkpoint_write', 0, 0],
  ['before_checkpoint_rename', 0, 0],
  ['after_checkpoint_rename', 0, 1],
  ['before_directory_sync', 0, 1],
  ['after_directory_sync', 1, 1],
  ['after_receipt', 1, 1],
];

const SAFE_RUN_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const SAFE_KERNEL = /^[0-9][0-9A-Za-z.+~-]*-generic$/u;
const SAFE_VERSION = /^[0-9][0-9A-Za-z.+~:-]*$/u;
const SAFE_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/u;
const SAFE_SHA = /^[0-9a-f]{40}$/u;
const WORKSPACE_ROOT = '/data/qualification/kungfu/durability';
const REPO_ROOTS = [
  '/home/dkr/Worktrees/kungfu/feature',
  '/data/worktrees/kungfu/feature',
];

function requireSafe(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`unsafe ${label}: ${value}`);
  return value;
}

function requireBelow(value, root, label) {
  if (!path.posix.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute Linux path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized === root || !normalized.startsWith(`${root}/`)) {
    throw new Error(`${label} must be below ${root}`);
  }
  return normalized;
}

function requireRepo(value) {
  for (const root of REPO_ROOTS) {
    try {
      return requireBelow(value, root, 'repo');
    } catch {
      // Keep the historical qualification root readable while requiring new
      // runs to use the canonical root listed first.
    }
  }
  throw new Error(`repo must be below ${REPO_ROOTS.join(' or ')}`);
}

function command(id, mutates, argv, note, cwd = null) {
  return { id, mutates, argv, note, cwd };
}

export function createPowerCutPlan(input) {
  const runId = requireSafe(input.runId, SAFE_RUN_ID, 'run id');
  const kernelRelease = requireSafe(
    input.kernelRelease,
    SAFE_KERNEL,
    'kernel release',
  );
  const kernelVersion = requireSafe(
    input.kernelVersion,
    SAFE_VERSION,
    'kernel version',
  );
  const image = requireSafe(input.image, SAFE_IMAGE, 'container image');
  const sourceRevision = requireSafe(
    input.sourceRevision,
    SAFE_SHA,
    'source revision',
  );
  const repo = requireRepo(input.repo);
  const workspace = `${WORKSPACE_ROOT}/${runId}`;
  const container = `kf-durability-${runId}`;
  const packageName = `linux-image-unsigned-${kernelRelease}`;
  const deb = `${workspace}/${packageName}_${kernelVersion}_amd64.deb`;
  const fixture = `${repo}/framework/core/build/Release/kungfu_durability_powercut_fixture`;
  const library = `${repo}/framework/core/build/Release/libkungfu_runtime.so`;
  const guestInit = `${repo}/framework/core/tests/qualification/durability/powercut_guest_init`;
  const sentinel = `${repo}/framework/core/tests/qualification/durability/powercut_disposable_root_sentinel`;
  const workspaceSentinel = `${repo}/framework/core/tests/qualification/durability/powercut_qemu_workspace_sentinel`;
  const rootfsTree = `${workspace}/rootfs-tree`;
  const dataSeed = `${workspace}/data-seed`;

  return {
    schema: 'kungfu.durability.powercut-plan/v1',
    mode: 'dry-run-only',
    requires_explicit_confirmation: true,
    target: {
      host: 'agent-120',
      filesystem: 'ext4',
      repo,
      workspace,
      source_revision: sourceRevision,
      image,
      kernel_release: kernelRelease,
      kernel_version: kernelVersion,
    },
    safety: {
      creates_only_below: workspace,
      refuses_existing_workspace: true,
      disposable_container: container,
      qemu_pid_must_be_direct_child: true,
      termination_signal: 'SIGKILL',
      physical_host_restart: false,
      physical_device_write: false,
      github_workflow: false,
    },
    prepare: [
      command(
        'source-revision',
        false,
        ['git', '-C', repo, 'rev-parse', 'HEAD'],
        'must equal source_revision',
      ),
      command(
        'workspace-absent',
        false,
        ['test', '!', '-e', workspace],
        'fail closed instead of overwriting evidence',
      ),
      command(
        'fixture-present',
        false,
        ['test', '-x', fixture],
        'fixture must be built through local Shifu first',
      ),
      command(
        'initrd-readable',
        false,
        ['test', '-r', `/boot/initrd.img-${kernelRelease}`],
        'reuse the installed matching initrd',
      ),
      command(
        'image-present',
        false,
        ['docker', 'image', 'inspect', image],
        'no image pull is planned',
      ),
      command(
        'create-layout',
        true,
        [
          'mkdir',
          '-p',
          `${workspace}/kernel`,
          rootfsTree,
          dataSeed,
          `${workspace}/evidence`,
        ],
        'creates a new run-scoped workspace',
      ),
      command(
        'download-kernel',
        true,
        ['apt-get', 'download', `${packageName}=${kernelVersion}`],
        `downloads ${deb}`,
        workspace,
      ),
      command(
        'install-workspace-sentinel',
        true,
        [
          'install',
          '-m',
          '0644',
          workspaceSentinel,
          `${workspace}/.kungfu-disposable-qemu-workspace`,
        ],
        'binds later execution to this exact disposable workspace',
      ),
      command(
        'extract-kernel',
        true,
        ['dpkg-deb', '-x', deb, `${workspace}/kernel`],
        'does not install a host package',
      ),
      command(
        'copy-initrd',
        true,
        ['cp', `/boot/initrd.img-${kernelRelease}`, `${workspace}/initrd.img`],
        'copies into the disposable workspace',
      ),
      command(
        'create-container',
        true,
        ['docker', 'create', '--name', container, image],
        'creates one named disposable container',
      ),
      command(
        'export-container',
        true,
        ['docker', 'export', '--output', `${workspace}/rootfs.tar`, container],
        'exports without starting the container',
      ),
      command(
        'remove-container',
        true,
        ['docker', 'rm', container],
        'removes only the exact run-scoped container',
      ),
      command(
        'extract-rootfs',
        true,
        ['tar', '-xf', `${workspace}/rootfs.tar`, '-C', rootfsTree],
        'populates the disposable guest root',
      ),
      command(
        'install-fixture',
        true,
        [
          'install',
          '-D',
          '-m',
          '0755',
          fixture,
          `${rootfsTree}/opt/kungfu/kungfu_durability_powercut_fixture`,
        ],
        'copies the exact locally built fixture',
      ),
      command(
        'install-library',
        true,
        [
          'install',
          '-D',
          '-m',
          '0755',
          library,
          `${rootfsTree}/usr/lib/x86_64-linux-gnu/libkungfu_runtime.so`,
        ],
        'installs the fixture build library into the guest loader path',
      ),
      command(
        'install-guest-init',
        true,
        [
          'install',
          '-D',
          '-m',
          '0755',
          guestInit,
          `${rootfsTree}/opt/kungfu/powercut_guest_init`,
        ],
        'guest-only init; it cannot control the host',
      ),
      command(
        'install-sentinel',
        true,
        [
          'install',
          '-D',
          '-m',
          '0644',
          sentinel,
          `${dataSeed}/.kungfu-disposable-powercut-fixture`,
        ],
        'marks only the disposable data image',
      ),
      command(
        'allocate-rootfs',
        true,
        ['truncate', '-s', '4G', `${workspace}/rootfs-base.ext4`],
        'new sparse baseline image',
      ),
      command(
        'format-rootfs',
        true,
        [
          'mkfs.ext4',
          '-F',
          '-L',
          'KFROOT',
          '-d',
          rootfsTree,
          `${workspace}/rootfs-base.ext4`,
        ],
        'formats only the new sparse baseline file',
      ),
      command(
        'allocate-data',
        true,
        ['truncate', '-s', '256M', `${workspace}/data-base.ext4`],
        'new sparse baseline image',
      ),
      command(
        'format-data',
        true,
        [
          'mkfs.ext4',
          '-F',
          '-L',
          'KFDATA',
          '-d',
          dataSeed,
          `${workspace}/data-base.ext4`,
        ],
        'formats only the new sparse baseline file',
      ),
    ],
    profiles: ['durable_group', 'durable_sync'],
    trials: ['durable_group', 'durable_sync'].flatMap((profile) =>
      POWER_CUT_FAULTS.map(([fault, minimum, maximum]) => {
        const trialId = `${profile}-${fault}`;
        const writeRootfs = `${workspace}/${trialId}-write-rootfs.qcow2`;
        const verifyRootfs = `${workspace}/${trialId}-verify-rootfs.qcow2`;
        const data = `${workspace}/${trialId}-data.ext4`;
        return {
          id: trialId,
          profile,
          fault,
          expected_durable_sequence: { minimum, maximum },
          arm_marker: `KF_POWER_CUT_ARMED fault=${fault} sequence=1`,
          reset: [
            command(
              'clone-rootfs',
              true,
              [
                'qemu-img',
                'create',
                '-f',
                'qcow2',
                '-F',
                'raw',
                '-b',
                `${workspace}/rootfs-base.ext4`,
                writeRootfs,
              ],
              'fresh write guest overlay; rootfs is not the durability test device',
            ),
            command(
              'clone-verify-rootfs',
              true,
              [
                'qemu-img',
                'create',
                '-f',
                'qcow2',
                '-F',
                'raw',
                '-b',
                `${workspace}/rootfs-base.ext4`,
                verifyRootfs,
              ],
              'fresh verification guest overlay independent from the killed guest',
            ),
            command(
              'clone-data',
              true,
              [
                'cp',
                '--reflink=auto',
                '--sparse=always',
                `${workspace}/data-base.ext4`,
                data,
              ],
              'fresh sequence-1 data state for this trial',
            ),
          ],
          serial_log: `${workspace}/evidence/${trialId}.serial.log`,
          pid_file: `${workspace}/evidence/${trialId}.qemu.pid`,
          write_kernel_args: `root=/dev/vda rw console=ttyS0 panic=-1 init=/opt/kungfu/powercut_guest_init kf_mode=write kf_profile=${profile} kf_fault=${fault}`,
          verify_kernel_args: `root=/dev/vda rw console=ttyS0 panic=-1 init=/opt/kungfu/powercut_guest_init kf_mode=verify kf_min=${minimum} kf_max=${maximum}`,
          qemu_argv_prefix: [
            'qemu-system-x86_64',
            '-enable-kvm',
            '-m',
            '2048',
            '-smp',
            '2',
            '-nographic',
            '-no-reboot',
            '-kernel',
            `${workspace}/kernel/boot/vmlinuz-${kernelRelease}`,
            '-initrd',
            `${workspace}/initrd.img`,
            '-drive',
            'if=virtio,format=qcow2,file=ROOT_OVERLAY',
            '-drive',
            `if=virtio,format=raw,cache=none,aio=native,file=${data}`,
          ],
          write_rootfs: writeRootfs,
          verify_rootfs: verifyRootfs,
          termination: {
            precondition:
              'the direct child serial log contains the exact arm_marker',
            action:
              'send SIGKILL only to the direct QEMU child PID, wait for exit, then boot verify mode',
          },
          verification_termination: {
            precondition:
              'the direct child serial log contains KF_GUEST_EXIT mode=verify status=0 and a passed JSON record',
            action:
              'send SIGTERM only to the direct verification QEMU child PID',
          },
        };
      }),
    ),
  };
}
