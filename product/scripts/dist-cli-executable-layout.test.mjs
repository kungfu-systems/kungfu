// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cliArchiveLayout, verifyDarwinCliExecutableLayout } from './dist.mjs';

test('macOS CLI executable qualification is architecture-exact and signed', (t) => {
  if (process.platform !== 'darwin') {
    t.skip('macOS executable qualification');
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-macos-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = cliArchiveLayout('darwin');
  const files = [
    layout.runtimeEntrypoint,
    layout.pythonEntrypoint,
    'tui/node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
    'tui/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  ];
  for (const relative of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
    fs.chmodSync(file, 0o755);
  }
  const calls = [];
  const result = verifyDarwinCliExecutableLayout(root, (command, args) => {
    calls.push([command, ...args]);
    return {
      status: 0,
      stdout: command === 'file' ? 'Mach-O 64-bit arm64\n' : '',
      stderr: '',
    };
  });

  assert.equal(result.architectureExact, true);
  assert.equal(result.codesignStrict, true);
  assert.equal(calls.filter(([command]) => command === 'file').length, 4);
  assert.equal(calls.filter(([command]) => command === 'codesign').length, 4);
});
