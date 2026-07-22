// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkRoot, scanText } from './check-shifu-entry-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('accepts Shifu commands in participant documentation', () => {
  assert.deepEqual(
    scanText('AGENTS.md', '```sh\n./shifu build\n./shifu check\n```\n'),
    [],
  );
});

test('rejects direct package-manager commands in participant documentation', () => {
  const findings = scanText('AGENTS.md', '```sh\npnpm build\n```\n');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].tool, 'pnpm');
  assert.equal(findings[0].line, 2);
});

test('rejects direct node in a workflow run block', () => {
  const findings = scanText(
    '.github/workflows/example.yml',
    'steps:\n  - run: |\n      node scripts/build.mjs\n',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].tool, 'node');
});

test('allows one explicitly justified implementation command', () => {
  const findings = scanText(
    '.github/workflows/example.yml',
    'steps:\n  - run: |\n      # shifu-entry-contract: allow launcher release bootstrap\n      node scripts/release-launcher.mjs\n      node scripts/build.mjs\n',
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].line, 5);
});

test('current participant surfaces satisfy the contract', () => {
  assert.deepEqual(checkRoot(ROOT), []);
});

test('cache execution boundaries distinguish gate run and source acceptance', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const native = fs.readFileSync(
    path.join(ROOT, 'crates', 'shifu', 'src', 'main.rs'),
    'utf8',
  );

  for (const entrypoint of [posix, windows]) {
    assert.match(entrypoint, /SHIFU_CACHE_BYPASS/);
    assert.match(entrypoint, /source-acceptance/);
    assert.match(entrypoint, /shifu-cache-entry: source-acceptance-bypass/);
    assert.match(entrypoint, /shifu-cache-entry: gate-run-outer-apply/);
  }
  assert.match(windows, /_KFC_FORWARD_ARGS=%\*/);
  assert.match(windows, /_KFC_FORWARD_ARGS:\* =%/);
  assert.match(native, /gate_subcommand/);
  assert.match(native, /cache_bypass/);
});

test('Xinfa product tasks bypass unrelated Kungfu dependency caches', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  for (const entrypoint of [posix, windows]) {
    assert.match(entrypoint, /shifu-xinfa-entry: cache-independent/);
    assert.match(entrypoint, /xinfa[\\/]tooling[\\/]task\.mjs/);
    for (const task of ['build', 'check', 'standalone']) {
      assert.match(entrypoint, new RegExp(`xinfa:${task}`));
    }
  }
});

test('Xinfa source entry prefers hash-pinned wasm and preserves native fallback', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  for (const entrypoint of [posix, windows]) {
    assert.match(
      entrypoint,
      /shifu-xinfa-source-entry: hash-pinned-wasm-with-native-fallback/,
    );
    assert.match(entrypoint, /wasm-host\.mjs/);
    assert.match(entrypoint, /--engine-status/);
    assert.match(entrypoint, /falling back to the native/);
    assert.match(
      entrypoint,
      /cargo run --locked --quiet --manifest-path crates[\\/]Cargo\.toml -p kungfu-trunk -- xinfa --source-argv/,
    );
    assert.match(entrypoint, /XINFA_CARGO_TARGET_DIR/);
  }
});

test('Xinfa quality uses the source resolver and forwards one Windows mode', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const posixBlock = posix.match(/xinfa:quality\)[\s\S]*?;;/u)?.[0];
  const windowsBlock = windows.match(
    /:xinfaquality[\s\S]*?:docsreadonly/u,
  )?.[0];
  assert.ok(posixBlock, 'POSIX Xinfa quality block is missing');
  assert.ok(windowsBlock, 'Windows Xinfa quality block is missing');
  assert.doesNotMatch(posixBlock, /xinfa\/tooling\/task\.mjs build/u);
  assert.doesNotMatch(windowsBlock, /xinfa\\tooling\\task\.mjs" build/u);
  assert.match(windowsBlock, /%~2/u);
  assert.match(windowsBlock, /"%_XINFA_QUALITY_MODE%"/u);
  assert.doesNotMatch(windowsBlock, /\s%\*/u);
});

test('Windows source-fresh launcher retries one transient build failure', () => {
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const sourceBuild = windows.match(
    /echo shifu: building launcher from source[\s\S]*?echo shifu: source build failed; falling back/,
  )?.[0];
  assert.ok(sourceBuild, 'Windows source-build block is missing');
  assert.equal(
    sourceBuild.match(
      /cargo build --release --locked --manifest-path crates\\Cargo\.toml -p shifu/g,
    )?.length,
    2,
  );
  assert.match(sourceBuild, /_KFC_BUILD_ERROR=!errorlevel!/);
  assert.match(sourceBuild, /_KFC_TGT=!_KFC_TGT!-retry-!RANDOM!-!RANDOM!/);
  assert.match(sourceBuild, /ping -n 3 127\.0\.0\.1/);
  assert.match(sourceBuild, /if "!_KFC_BUILD_ERROR!"=="0" \(/);
});

test('source-fresh launchers pin nested Shifu entry to the resolved binary', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  assert.ok(
    posix.match(/SHIFU_BIN="\$kungfu_dev_bin" exec "\$kungfu_dev_bin"/g)
      ?.length >= 2,
  );
  assert.ok(windows.match(/set "SHIFU_BIN=%_KFC_DEVBIN%"/g)?.length >= 2);
});

test('cold source acquisition copies the binary from its isolated Cargo target', () => {
  const posix = fs.readFileSync(path.join(ROOT, 'shifu'), 'utf8');
  const windows = fs.readFileSync(path.join(ROOT, 'shifu.cmd'), 'utf8');
  const posixAcquire = posix.match(
    /kungfu_native_acquire\(\) \{[\s\S]*?^\}/mu,
  )?.[0];
  const windowsAcquire = windows.match(/:acquire[\s\S]*?:inscript/u)?.[0];
  assert.ok(posixAcquire, 'POSIX cold-acquire block is missing');
  assert.ok(windowsAcquire, 'Windows cold-acquire block is missing');
  assert.match(
    posixAcquire,
    /CARGO_TARGET_DIR="\$_tgt" cargo build --release --locked/,
  );
  assert.match(posixAcquire, /_built="\$_tgt\/release\//);
  assert.doesNotMatch(posixAcquire, /crates\/target\/release/);
  assert.match(windowsAcquire, /_KFC_ACQUIRE_TGT=/);
  assert.match(windowsAcquire, /set "CARGO_TARGET_DIR=!_KFC_ACQUIRE_TGT!"/);
  assert.match(windowsAcquire, /cargo build --release --locked/);
  assert.match(windowsAcquire, /!_KFC_ACQUIRE_TGT!\\release\\shifu\.exe/);
  assert.doesNotMatch(windowsAcquire, /crates\\target\\release/);
});

test('runtime guard rejects a direct task and accepts Shifu provenance', () => {
  const guard = path.join(ROOT, 'scripts', 'require-shifu.mjs');
  const rejected = spawnSync(process.execPath, [guard, 'build:core'], {
    encoding: 'utf8',
    env: { ...process.env, SHIFU_ENTRYPOINT: '' },
  });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /Run: \.\/shifu build:core/);

  const accepted = spawnSync(process.execPath, [guard, 'build:core'], {
    encoding: 'utf8',
    env: { ...process.env, SHIFU_ENTRYPOINT: '1' },
  });
  assert.equal(accepted.status, 0);
});

test('package manager cannot run a guarded root task without Shifu', () => {
  const corepack = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
  const direct = spawnSync(corepack, ['pnpm', 'run', 'check:entry-contract'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, SHIFU_ENTRYPOINT: '' },
    shell: process.platform === 'win32',
  });
  assert.equal(direct.status, 1);
  assert.match(
    `${direct.stdout}\n${direct.stderr}`,
    /Direct package-manager invocation is unsupported/,
  );
  assert.match(
    `${direct.stdout}\n${direct.stderr}`,
    /\.\/shifu check:entry-contract/,
  );
});
