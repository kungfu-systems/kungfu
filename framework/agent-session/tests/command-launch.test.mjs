// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { commandLaunchSpec } from '../src/command-launch.mjs';

test('native executables retain exact argv on every platform', () => {
  assert.deepEqual(
    commandLaunchSpec({
      executable: '/agent/bin/codex',
      argv: ['app-server', '--stdio'],
      platform: 'linux',
    }),
    {
      executable: '/agent/bin/codex',
      argv: ['app-server', '--stdio'],
      commandWrapper: false,
      windowsVerbatimArguments: false,
    },
  );
  assert.equal(
    commandLaunchSpec({
      executable: 'C:\\agent\\codex.exe',
      argv: [],
      platform: 'win32',
    }).commandWrapper,
    false,
  );
});

test('Windows wrapper routing is provider and version neutral', () => {
  for (const executable of [
    'C:\\agent cli\\codex.CMD',
    'C:\\agent cli\\claude.cmd',
    'C:\\agent cli\\opencode.BAT',
    'C:\\agent cli\\future-agent.bat',
  ]) {
    const launch = commandLaunchSpec({
      executable,
      argv: ['--version-independent'],
      env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      platform: 'win32',
    });
    assert.equal(launch.executable, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(launch.argv.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
    assert.match(launch.argv[4], /^call /u);
    assert.equal(launch.commandWrapper, true);
    assert.equal(launch.windowsVerbatimArguments, true);
  }
});
test('Windows wrapper routing rejects expansion and command injection text', () => {
  for (const unsafe of ['%PATH%', 'line\rbreak', 'line\nbreak']) {
    assert.throws(
      () =>
        commandLaunchSpec({
          executable: 'C:\\agent\\codex.cmd',
          argv: [unsafe],
          platform: 'win32',
        }),
      /cmd\.exe could expand/u,
    );
  }
});

test(
  'Windows command wrapper preserves piped stdio through explicit ComSpec',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-agent-launch-'));
    t.after(() => fs.rmSync(temp, { force: true, recursive: true }));
    const provider = path.join(temp, 'provider.mjs');
    const wrapper = path.join(temp, 'provider.cmd');
    fs.writeFileSync(
      provider,
      [
        "process.stdin.setEncoding('utf8');",
        "process.stdin.once('data', (data) => {",
        "  process.stdout.write(JSON.stringify({ received: data.trim(), argv: process.argv.slice(2) }) + '\\n');",
        '});',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(
      wrapper,
      '@echo off\r\n"%NODE_EXE%" "%PROVIDER_SCRIPT%" %*\r\n',
      'utf8',
    );
    const env = {
      ...process.env,
      NODE_EXE: process.execPath,
      PROVIDER_SCRIPT: provider,
    };
    const launch = commandLaunchSpec({
      executable: wrapper,
      argv: ['app-server', '--stdio'],
      env,
    });
    const child = spawn(launch.executable, launch.argv, {
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.end('{"method":"initialize"}\n');
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.deepEqual(exit, { code: 0, signal: null }, stderr);
    assert.deepEqual(JSON.parse(stdout), {
      received: '{"method":"initialize"}',
      argv: ['app-server', '--stdio'],
    });
  },
);
