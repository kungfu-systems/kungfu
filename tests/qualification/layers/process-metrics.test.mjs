// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { qualificationHoldMs, runMeasured } from './process-metrics.mjs';

test('keeps Windows qualification processes observable to tasklist', () => {
  assert.equal(qualificationHoldMs('win32'), 1000);
  assert.equal(qualificationHoldMs('linux'), 1000);
  assert.equal(qualificationHoldMs('darwin'), 100);
});

test('records peak resident memory for a short-lived cross-platform process', async () => {
  const result = await runMeasured(process.execPath, [
    '-e',
    'const data = Buffer.alloc(4 * 1024 * 1024); setTimeout(() => console.log(data.length), 150)',
  ]);
  assert.match(result.stdout, /4194304/);
  assert.ok(result.durationMs >= 100);
  assert.ok(result.peakResidentBytes > 4 * 1024 * 1024);
});

test(
  'measures a Windows command shim only through an explicit shell',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-metrics-'));
    t.after(() => fs.rmSync(temp, { force: true, recursive: true }));
    const shim = path.join(temp, 'measured.cmd');
    fs.writeFileSync(
      shim,
      '@echo off\r\n"%NODE_EXE%" -e "setTimeout(function(){console.log(4096)}, 1000)"\r\n',
      'utf8',
    );
    const result = await runMeasured(shim, [], {
      cwd: temp,
      env: { ...process.env, NODE_EXE: process.execPath },
      shell: true,
    });
    assert.match(result.stdout, /4096/u);
    assert.ok(result.peakResidentBytes > 0);
  },
);
