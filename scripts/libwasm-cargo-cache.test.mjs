// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { selectCommandPath, spawnSpecification } from './libwasm-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = path.join(
  root,
  'framework',
  'core',
  '.cmake',
  'libwasm-cargo-cache.cmake',
);

test('Windows qualification prefers an executable Cargo wrapper', () => {
  assert.equal(
    selectCommandPath(
      [
        'C:\\cache-overlay\\bin\\cargo',
        'C:\\cache-overlay\\bin\\cargo.cmd',
        'C:\\rust\\bin\\cargo.exe',
      ].join('\r\n'),
      'win32',
    ),
    'C:\\cache-overlay\\bin\\cargo.cmd',
  );
});

test('Windows qualification runs Cargo command wrappers through cmd.exe', () => {
  assert.deepEqual(
    spawnSpecification('C:\\cache overlay\\bin\\cargo.cmd', ['-Vv'], 'win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
    }),
    {
      command: '"C:\\cache overlay\\bin\\cargo.cmd" "-Vv"',
      args: [],
      shell: 'C:\\Windows\\System32\\cmd.exe',
    },
  );
});

test('Windows Cargo command wrappers are identified through cmd.exe', () => {
  const source = fs.readFileSync(modulePath, 'utf8');
  assert.match(source, /WIN32 AND KF_CARGO MATCHES/);
  assert.match(
    source,
    /set\(CARGO_VERSION_COMMAND cmd\.exe \/d \/s \/c call "\$\{KF_CARGO\}" -Vv\)/,
  );
});

test(
  'Windows executes a spaced Cargo command-wrapper path through cmd.exe',
  { skip: process.platform !== 'win32' },
  () => {
    const work = fs.mkdtempSync(
      path.join(os.tmpdir(), 'kungfu-cargo-wrapper-'),
    );
    try {
      const source = path.join(work, 'source');
      const wrapperDir = path.join(work, 'wrapper with spaces');
      fs.mkdirSync(source);
      fs.mkdirSync(wrapperDir);
      const lock = path.join(source, 'Cargo.lock');
      const cargo = path.join(wrapperDir, 'cargo.cmd');
      fs.writeFileSync(lock, 'version = 4\n');
      fs.writeFileSync(cargo, '@echo off\r\necho cargo 1.96.0 (fixture)\r\n');
      const locatedRustc = spawnSync('where.exe', ['rustc'], {
        encoding: 'utf8',
      });
      assert.equal(locatedRustc.status, 0, locatedRustc.stderr);
      const rustc = locatedRustc.stdout.trim().split(/\r?\n/u)[0];
      const script = path.join(work, 'resolve-wrapper.cmake');
      fs.writeFileSync(
        script,
        `include("${cmakePath(modulePath)}")
kungfu_resolve_libwasm_cargo_target(OUT_DIR OUT_KEY
  NAME "wasmtime"
  MANIFEST_DIR "${cmakePath(source)}"
  LOCKFILE "${cmakePath(lock)}"
  SOURCE_ROOT "${cmakePath(source)}"
  PROFILE release
  CACHE_ROOT "${cmakePath(path.join(work, 'cache'))}"
  CARGO "${cmakePath(cargo)}"
  RUSTC "${cmakePath(rustc)}"
  TARGET "test-target")
message("RESULT|\${OUT_KEY}|\${OUT_DIR}")
`,
      );
      const result = spawnSync('cmake', ['-P', script], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(`${result.stdout}${result.stderr}`, /RESULT\|v1-/);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  },
);

function cmakePath(value) {
  return value.replaceAll('\\', '/').replaceAll('"', '\\"');
}

function resolveCache({
  source,
  lock,
  name = 'wasmtime',
  toolchain = 'rust-1',
}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kungfu-libwasm-cache-'));
  const cacheRoot = path.join(work, 'cache');
  const script = path.join(work, 'resolve.cmake');
  fs.writeFileSync(
    script,
    `include("${cmakePath(modulePath)}")
kungfu_resolve_libwasm_cargo_target(OUT_DIR OUT_KEY
  NAME "${name}"
  MANIFEST_DIR "${cmakePath(source)}"
  LOCKFILE "${cmakePath(lock)}"
  SOURCE_ROOT "${cmakePath(source)}"
  PROFILE release
  CACHE_ROOT "${cmakePath(cacheRoot)}"
  TOOLCHAIN_FINGERPRINT "${toolchain}"
  TARGET "test-target")
message("RESULT|\${OUT_KEY}|\${OUT_DIR}")
`,
  );
  const result = spawnSync('cmake', ['-P', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const match = `${result.stdout}${result.stderr}`.match(
    /RESULT\|([^|]+)\|(.+)/,
  );
  assert.ok(match, `${result.stdout}\n${result.stderr}`);
  return { key: match[1], dir: match[2].trim(), cacheRoot };
}

test('libwasm Cargo cache key is stable and isolates invalidation axes', () => {
  const fixture = fs.mkdtempSync(
    path.join(os.tmpdir(), 'kungfu-libwasm-fixture-'),
  );
  const sourceA = path.join(fixture, 'source-a');
  const sourceB = path.join(fixture, 'source-b');
  fs.mkdirSync(sourceA);
  fs.mkdirSync(sourceB);
  const lockA = path.join(sourceA, 'Cargo.lock');
  const lockB = path.join(sourceB, 'Cargo.lock');
  fs.writeFileSync(lockA, 'version = 4\n');
  fs.writeFileSync(lockB, 'version = 4\n');

  const first = resolveCache({ source: sourceA, lock: lockA });
  const repeat = resolveCache({ source: sourceA, lock: lockA });
  assert.equal(first.key, repeat.key);
  assert.match(first.dir, /[/\\]wasmtime[/\\]release[/\\]v1-/);
  assert.ok(path.resolve(first.dir).startsWith(path.resolve(first.cacheRoot)));

  fs.writeFileSync(lockA, 'version = 4\n# changed\n');
  assert.notEqual(
    first.key,
    resolveCache({ source: sourceA, lock: lockA }).key,
  );
  assert.notEqual(
    first.key,
    resolveCache({ source: sourceB, lock: lockB }).key,
  );
  assert.notEqual(
    first.key,
    resolveCache({ source: sourceA, lock: lockB, name: 'wasmer' }).key,
  );
  assert.notEqual(
    first.key,
    resolveCache({ source: sourceA, lock: lockB, toolchain: 'rust-2' }).key,
  );
});
