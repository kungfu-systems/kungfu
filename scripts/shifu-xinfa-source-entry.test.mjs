// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sourceCommandArguments } from '../crates/xinfa/tooling/source-command-arguments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIFU = path.join(ROOT, 'shifu');

test('Windows source resolver tail-delegates without CALL re-expansion', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'crates', 'xinfa', 'tooling', 'source-xinfa.cmd'),
    'utf8',
  );
  assert.doesNotMatch(source, /\bcall\b/i);
  assert.match(source, /"%~dp0\.\.\\\.\.\\\.\.\\shifu\.cmd" xinfa %\*/i);
});

test('Windows source consumers preserve paths and task text as argv items', () => {
  assert.deepEqual(
    sourceCommandArguments(
      'C:\\repo\\xinfa\\tooling\\source-xinfa.cmd',
      ['context', '--task', 'deterministic source action', '--json'],
      'win32',
    ),
    ['"context"', '"--task"', '"deterministic source action"', '"--json"'],
  );
});

function fixture(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-xinfa-source-'));
  const cargo = path.join(root, 'cargo');
  fs.writeFileSync(cargo, `#!/bin/sh\nset -eu\n${body}\n`);
  fs.chmodSync(cargo, 0o755);
  return { root, cargo };
}

function environment(root, extra = {}) {
  return {
    ...process.env,
    PATH: `${root}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    XINFA_CARGO_TARGET_DIR: path.join(root, 'target'),
    ...extra,
  };
}

test('source Xinfa entry preserves argv, stdio, exit code, and linked-trunk target ownership', () => {
  const { root } = fixture(`
printf '%s\\n' "$@" > "$FAKE_ARGV"
printf '%s' "$CARGO_TARGET_DIR" > "$FAKE_TARGET"
cat > "$FAKE_STDIN"
printf 'xinfa-json'
printf 'cargo-diagnostic' >&2
exit 23`);
  try {
    const argv = path.join(root, 'argv');
    const target = path.join(root, 'target-path');
    const stdin = path.join(root, 'stdin');
    const result = spawnSync(
      SHIFU,
      ['xinfa', 'contract', '--label', 'two words'],
      {
        cwd: ROOT,
        encoding: 'utf8',
        input: 'source-input',
        env: environment(root, {
          FAKE_ARGV: argv,
          FAKE_TARGET: target,
          FAKE_STDIN: stdin,
        }),
      },
    );
    assert.equal(result.status, 23);
    assert.equal(result.stdout, 'xinfa-json');
    assert.equal(
      result.stderr,
      'shifu: Node is unavailable; falling back to the native Xinfa trunk/cargo path\n' +
        'cargo-diagnostic',
    );
    assert.deepEqual(fs.readFileSync(argv, 'utf8').trim().split('\n'), [
      'run',
      '--locked',
      '--quiet',
      '--manifest-path',
      'crates/Cargo.toml',
      '-p',
      'kungfu-trunk',
      '--',
      'xinfa',
      '--source-argv',
      'contract',
      '--label',
      'two words',
    ]);
    assert.equal(fs.readFileSync(target, 'utf8'), path.join(root, 'target'));
    assert.equal(fs.readFileSync(stdin, 'utf8'), 'source-input');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source Xinfa entry reuses only an explicit prebuilt trunk without Cargo', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shifu-xinfa-prebuilt-'));
  const trunk = path.join(root, 'kungfu-trunk');
  const argv = path.join(root, 'argv');
  fs.writeFileSync(
    trunk,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$FAKE_ARGV"\nprintf prebuilt-trunk\nexit 19\n',
  );
  fs.chmodSync(trunk, 0o755);
  try {
    const result = spawnSync(SHIFU, ['xinfa', 'contract', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: environment(root, {
        FAKE_ARGV: argv,
        KUNGFU_TRUNK_BIN: trunk,
      }),
    });
    assert.equal(result.status, 19);
    assert.equal(result.stdout, 'prebuilt-trunk');
    assert.deepEqual(fs.readFileSync(argv, 'utf8').trim().split('\n'), [
      'xinfa',
      '--source-argv',
      'contract',
      '--json',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source Xinfa entry is replaced by Cargo for signal delivery', async () => {
  const { root } = fixture(`
trap 'trap - TERM; kill -TERM $$' TERM
printf ready > "$FAKE_READY"
while :; do sleep 1; done`);
  try {
    const ready = path.join(root, 'ready');
    const child = spawn(SHIFU, ['xinfa', '--version'], {
      cwd: ROOT,
      stdio: 'ignore',
      env: environment(root, { FAKE_READY: ready }),
    });
    for (let attempt = 0; attempt < 100 && !fs.existsSync(ready); attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(ready), 'fake Cargo did not start');
    child.kill('SIGTERM');
    const closed = await new Promise((resolve) =>
      child.once('close', (code, signal) => resolve({ code, signal })),
    );
    assert.deepEqual(closed, { code: null, signal: 'SIGTERM' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
