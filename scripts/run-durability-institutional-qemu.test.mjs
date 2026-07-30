// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const source = fs.readFileSync(
  new URL('./run-durability-institutional-qemu.mjs', import.meta.url),
  'utf8',
);

test('institutional QEMU qualification remains local and disposable', () => {
  assert.match(source, /disposable-backup-root/u);
  assert.match(source, /physical_host_restart_qualified: false/u);
  assert.match(source, /off_host_backup_qualified: false/u);
  assert.match(source, /github_workflow: false/u);
  assert.doesNotMatch(source, /gh workflow|workflow_dispatch|self-hosted/iu);
});

test('institutional evidence includes ENOSPC, restart, fsck, and restore', () => {
  assert.match(source, /real-enospc/u);
  assert.match(source, /recovery-\$\{attempt\}/u);
  assert.match(source, /e2fsck/u);
  assert.match(source, /backup-restore/u);
  assert.match(source, /maximum_observed_rpo_records: 0/u);
});
