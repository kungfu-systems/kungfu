// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseOptions, qemuArgs } from './run-durability-powercut-qemu.mjs';

test('QEMU execution arguments isolate root and raw durability devices', () => {
  const args = qemuArgs({
    workspace: '/data/qualification/kungfu/durability/run',
    rootfs: '/data/qualification/kungfu/durability/run/root.qcow2',
    data: '/data/qualification/kungfu/durability/run/data.ext4',
    kernelArgs: 'kf_mode=verify',
  });
  assert.ok(args.includes('-nic'));
  assert.ok(args.includes('none'));
  assert.ok(
    args.includes(
      'if=virtio,format=qcow2,file=/data/qualification/kungfu/durability/run/root.qcow2',
    ),
  );
  assert.ok(
    args.includes(
      'if=virtio,format=raw,cache=none,aio=native,file=/data/qualification/kungfu/durability/run/data.ext4',
    ),
  );
  assert.doesNotMatch(JSON.stringify(args), /github|self-hosted|buildchain/iu);
});

test('execution remains explicit', () => {
  assert.deepEqual(parseOptions(['--run-id', 'run']), {
    execute: false,
    'run-id': 'run',
  });
  assert.deepEqual(parseOptions(['--execute', '--run-id', 'run']), {
    execute: true,
    'run-id': 'run',
  });
  assert.throws(() => parseOptions(['--run-id']), /expected --key value/);
});
