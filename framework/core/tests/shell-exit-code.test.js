// SPDX-License-Identifier: Apache-2.0
//
// Signal-termination exit-code regression tests for the JS tooling layer.
//
// Guards the bug where `process.exit(spawnSync(...).status)` reported success
// (exit 0) when the child was terminated by a signal (`status === null`): a
// SIGKILL/OOM- or SIGTERM-killed build must report failure, not falsely pass.
//
//   1. unit — shell.exitCode maps (status, signal) to the right code
//   2. integration — shell.run() actually exits non-zero on the real
//      process.exit path when its child is signal-killed
//
// Run: node --test tests/shell-exit-code.test.js  (node pinned via .node-version)

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const shell = require('../lib/shell');

const SHELL_PATH = path.resolve(__dirname, '..', 'lib', 'shell.js');
const isWin = process.platform === 'win32';
const sig = os.constants.signals;

test('exitCode: normal success stays 0', () => {
  assert.strictEqual(shell.exitCode({ status: 0, signal: null }), 0);
});

test('exitCode: normal non-zero status passes through unchanged', () => {
  assert.strictEqual(shell.exitCode({ status: 2, signal: null }), 2);
  assert.strictEqual(shell.exitCode({ status: 127, signal: null }), 127);
});

test('exitCode: signal termination maps to POSIX 128+signal', () => {
  assert.strictEqual(
    shell.exitCode({ status: null, signal: 'SIGKILL' }),
    128 + sig.SIGKILL,
  ); // 137
  assert.strictEqual(
    shell.exitCode({ status: null, signal: 'SIGTERM' }),
    128 + sig.SIGTERM,
  ); // 143
  assert.strictEqual(
    shell.exitCode({ status: null, signal: 'SIGINT' }),
    128 + sig.SIGINT,
  ); //   130
});

test('exitCode: null status with no signal (e.g. failed to spawn) is a generic failure', () => {
  assert.strictEqual(shell.exitCode({ status: null, signal: null }), 1);
});

test('exitCode: a signal kill never collapses to 0 (the original bug)', () => {
  assert.notStrictEqual(shell.exitCode({ status: null, signal: 'SIGKILL' }), 0);
});

// Integration — drive the real shell.run() process.exit path in a child process.
// shell.run() hardcodes shell:true, so `kill -s KILL $$` makes the shell (the
// direct child) signal-kill itself → status===null, signal==='SIGKILL' → run()
// must process.exit(137), reproducing exactly the OOM/SIGKILL-during-build path.
const runDriver = (opts) =>
  spawnSync(
    process.execPath,
    [
      '-e',
      `const shell = require(${JSON.stringify(SHELL_PATH)});\n` +
        `shell.run('kill -s KILL $$', [], true, ${JSON.stringify(opts)});\n` +
        `process.exit(0);`,
    ],
    { encoding: 'utf8' },
  );

test(
  'shell.run: a signal-killed command exits 137 (128+SIGKILL), not 0',
  { skip: isWin ? 'POSIX signals only' : false },
  () => {
    const r = runDriver({ silent: true });
    assert.strictEqual(
      r.signal,
      null,
      'the driver process itself must exit normally',
    );
    assert.strictEqual(
      r.status,
      128 + sig.SIGKILL,
      `expected exit ${128 + sig.SIGKILL} (128+SIGKILL), got status=${r.status} signal=${r.signal}`,
    );
  },
);

test(
  'shell.run: tolerant still swallows a signal kill as 0 (escape hatch preserved)',
  { skip: isWin ? 'POSIX signals only' : false },
  () => {
    const r = runDriver({ silent: true, tolerant: true });
    assert.strictEqual(
      r.status,
      0,
      `tolerant should exit 0, got status=${r.status} signal=${r.signal}`,
    );
  },
);
