#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mode = process.argv[2];
const coreDir = path.resolve(__dirname, '..', '..');
const binding = require(path.join(coreDir, 'dist', 'kungfu', 'kungfu_node.node'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kf-watcher-runtime-'));
const watcher = new binding.Watcher(
  path.join(home, 'runtime'),
  `runtime_${mode}`,
  true,
  2,
);

function printableStats() {
  return Object.fromEntries(
    Object.entries(watcher.runtimeStats()).map(([key, value]) => [
      key,
      typeof value === 'bigint' ? value.toString() : value,
    ]),
  );
}

function fail(message) {
  process.stderr.write(`${JSON.stringify({ mode, error: message })}\n`);
  process.exit(2);
}

if (mode === 'pool') {
  watcher.start();
  const startedAt = Date.now();
  let completed = false;
  crypto.pbkdf2('watcher', 'pool', 1_000, 32, 'sha256', () => {
    completed = true;
    process.stdout.write(
      `${JSON.stringify({
        mode,
        elapsedMs: Date.now() - startedAt,
        stats: printableStats(),
      })}\n`,
    );
    watcher.quit();
  });
  setTimeout(() => {
    if (!completed) fail('libuv worker pool was starved by the watcher');
  }, 1_500);
} else if (mode === 'lifecycle') {
  watcher.start();
  setTimeout(() => watcher.quit(), 25);
  const deadline = Date.now() + 2_000;
  const poll = setInterval(() => {
    const stats = printableStats();
    if (!stats.running) {
      clearInterval(poll);
      process.stdout.write(`${JSON.stringify({ mode, stats })}\n`);
    } else if (Date.now() > deadline) {
      clearInterval(poll);
      fail('watcher did not stop within the lifecycle deadline');
    }
  }, 10);
} else if (mode === 'addon-exit') {
  watcher.start();
  setTimeout(() => process.exit(0), 25);
} else {
  fail(`unknown probe mode: ${mode}`);
}
